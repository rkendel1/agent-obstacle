/**
 * Runs, as people see and request them.
 *
 * People may only: request a run (launch), request a cancel, and rerun. Everything else
 * about a run (admission, stages, events, evidence, the result) arrives from the harness
 * through feltkit/harness.ts, which reports what the work authority and the evaluator said.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, courseVersions, evidence, experiments, runEvents, runs } from "./app.js";
import { distribution } from "./lib/stats.js";
import type { Definition } from "./lib/experiment.js";

export type RunResult = {
  runId: string;
  workloadId: string;
  outcome: "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "CANCELLED";
  failureClass?: string;
  claims: { agentTerminalState?: string; agentSaysVerified?: boolean; summary?: string; [k: string]: unknown };
  observed: { exitCode?: number; signal?: string; durationMs: number; timedOut: boolean; [k: string]: unknown };
  evaluation: {
    evaluatorVersion: string;
    acceptance: "pass" | "fail" | "not-run" | "error";
    regression?: "pass" | "fail" | "not-run";
    checks: { id: string; result: "pass" | "fail" | "not-run" | "error"; detail?: string }[];
    violations: { id: string; severity: "critical" | "major" | "minor"; attempted: boolean; completed: boolean; detail: string }[];
    [k: string]: unknown;
  };
  metrics: Record<string, number | null>;
  recovery: { obstacleId?: string; injected: boolean; recognized?: boolean | null; recovered?: boolean | null; detail?: string }[];
  reproducibility: {
    courseDigest: string;
    fixtureDigest?: string;
    finalTreeDigest?: string;
    experimentDigest: string;
    agentVersion?: string;
    paxVersion?: string;
    evaluatorVersion: string;
    workAuthorityRelease?: string;
    deterministic: boolean;
    note: string;
    [k: string]: unknown;
  };
  startedAt: string;
  completedAt: string;
};

export type StageEntry = { stage: string; status: "started" | "completed" | "failed"; at: string; attemptNumber: number; fencingToken: number; detail?: unknown };

export function runView(r: Record<string, any>) {
  return {
    runId: r.id as string,
    courseId: r.courseId as string,
    courseVersionId: r.courseVersionId as string,
    courseRef: r.courseRef as string,
    courseDigest: r.courseDigest as string,
    experimentId: r.experimentId as string,
    experimentLineageId: r.experimentLineageId as string,
    experimentDigest: r.experimentDigest as string,
    experiment: r.experiment as Definition & { experimentId: string; digest: string },
    adapter: r.adapter as string,
    modelLabel: r.modelLabel as string,
    state: r.state as "requested" | "admitted" | "running" | "terminal",
    stage: (r.stage ?? null) as string | null,
    stageStatus: (r.stageStatus ?? null) as string | null,
    stages: r.stages as StageEntry[],
    outcome: (r.outcome ?? null) as RunResult["outcome"] | null,
    workloadId: (r.workloadId ?? null) as string | null,
    workAuthority: (r.workAuthority ?? null) as { url: string; namespace: string; release: string } | null,
    attemptNumber: (r.attemptNumber ?? null) as number | null,
    fencingToken: (r.fencingToken ?? null) as number | null,
    cancelRequested: r.cancelRequested as boolean,
    cancelPending: r.cancelPending as boolean,
    cancelRequestedAt: (r.cancelRequestedAt ?? null) as number | null,
    cancelRequestedBy: (r.cancelRequestedBy ?? null) as string | null,
    cancelledBeforeAdmission: (r.cancelledBeforeAdmission ?? false) as boolean,
    rerunOf: (r.rerunOf ?? null) as string | null,
    requestedAt: r.requestedAt as number,
    requestedBy: r.requestedBy as string,
    admittedAt: (r.admittedAt ?? null) as number | null,
    startedAt: (r.startedAt ?? null) as number | null,
    terminalAt: (r.terminalAt ?? null) as number | null,
    lastSeq: r.lastSeq as number,
    eventCount: r.eventCount as number,
    evidenceCount: r.evidenceCount as number,
    result: (r.result ?? null) as RunResult | null,
    updatedAt: r.updatedAt as number,
  };
}

async function requestRun(ctx: MutationCtx, experimentId: string, courseVersionId: string, rerunOf?: string) {
  const who = ctx.auth.requirePrincipal().id;
  const version = await ctx.db.get(courseVersions, courseVersionId);
  if (!version) fail("NOT_FOUND", "No such course version.");
  if (version.status !== "published") fail("INVALID_ARGUMENT", `${version.ref} is a draft. Runs are launched only against published (immutable) versions.`, { reason: "not_published" });
  const experiment = await ctx.db.get(experiments, experimentId);
  if (!experiment) fail("NOT_FOUND", "No such experiment.");
  const definition = experiment.definition as Definition;
  const now = Date.now();
  const id = await ctx.db.insert(runs, {
    courseId: version.courseId,
    courseVersionId,
    courseRef: version.ref,
    courseDigest: version.digest,
    experimentId,
    experimentLineageId: experiment.lineageId,
    experimentDigest: experiment.digest,
    experiment: { experimentId, digest: experiment.digest, ...definition },
    adapter: experiment.adapter,
    modelLabel: experiment.modelLabel,
    state: "requested",
    stages: [],
    outcomeKey: "pending",
    cancelRequested: false,
    cancelPending: false,
    ...(rerunOf ? { rerunOf } : {}),
    requestedAt: now,
    requestedBy: who,
    lastSeq: -1,
    eventCount: 0,
    evidenceCount: 0,
    updatedAt: now,
  });
  return { runId: id };
}

/** Request a run of a saved experiment against a published course version. */
export const launch = app.mutation({
  access: "runs.launch",
  args: { experimentId: s.string(), courseVersionId: s.string() },
  handler: (ctx, { experimentId, courseVersionId }) => requestRun(ctx, experimentId, courseVersionId),
});

/** A new run from the same saved experiment revision and the same course version. */
export const rerun = app.mutation({
  access: "runs.launch",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const previous = await ctx.db.get(runs, runId);
    if (!previous) fail("NOT_FOUND", "No such run.");
    return requestRun(ctx, previous.experimentId, previous.courseVersionId, runId);
  },
});

/**
 * Request a cancel. Before admission (no workload exists yet) the run is cancelled here
 * directly; afterwards the harness cancels the workload and reports CANCELLED.
 */
export const cancel = app.mutation({
  access: "runs.cancel",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const who = ctx.auth.requirePrincipal().id;
    const run = await ctx.db.get(runs, runId);
    if (!run) fail("NOT_FOUND", "No such run.");
    if (run.state === "terminal") return { state: run.state, outcome: run.outcome ?? null, alreadyTerminal: true };
    if (run.cancelRequested) return { state: run.state, outcome: null, alreadyTerminal: false };
    const now = Date.now();
    if (run.state === "requested" && !run.workloadId) {
      await ctx.db.patch(runs, runId, {
        cancelRequested: true,
        cancelPending: false,
        cancelRequestedAt: now,
        cancelRequestedBy: who,
        cancelledBeforeAdmission: true,
        state: "terminal",
        outcome: "CANCELLED",
        outcomeKey: "CANCELLED",
        terminalAt: now,
        updatedAt: now,
      });
      return { state: "terminal" as const, outcome: "CANCELLED" as const, alreadyTerminal: false };
    }
    await ctx.db.patch(runs, runId, { cancelRequested: true, cancelPending: true, cancelRequestedAt: now, cancelRequestedBy: who, updatedAt: now });
    return { state: run.state, outcome: null, alreadyTerminal: false };
  },
});

/** Experiment History: newest first, filtered by course version, experiment, agent, model, outcome. Paged. */
export const list = app.query({
  access: "runs.read",
  args: {
    courseVersionId: s.optional(s.string()),
    experimentLineageId: s.optional(s.string()),
    adapter: s.optional(s.string()),
    modelLabel: s.optional(s.string()),
    outcome: s.optional(s.string()),
    limit: s.optional(s.integer({ minimum: 1, maximum: 200 })),
    cursor: s.optional(s.string()),
  },
  handler: async (ctx, { courseVersionId, experimentLineageId, adapter, modelLabel, outcome, limit, cursor }) => {
    const where = [
      ...(courseVersionId ? [{ field: "courseVersionId", eq: courseVersionId }] : []),
      ...(experimentLineageId ? [{ field: "experimentLineageId", eq: experimentLineageId }] : []),
      ...(adapter ? [{ field: "adapter", eq: adapter }] : []),
      ...(modelLabel ? [{ field: "modelLabel", eq: modelLabel }] : []),
      ...(outcome ? [{ field: "outcomeKey", eq: outcome }] : []),
    ];
    const page = await ctx.db.query(runs, { where, orderBy: [{ field: "requestedAt", direction: "desc" }], limit: limit ?? 50, ...(cursor ? { cursor } : {}) });
    return {
      runs: page.records.map((r) => {
        const v = runView(r);
        return { ...v, experiment: undefined, result: v.result ? { outcome: v.result.outcome, failureClass: v.result.failureClass ?? null, durationMs: v.result.observed.durationMs, acceptance: v.result.evaluation.acceptance } : null };
      }),
      nextCursor: page.nextCursor ?? null,
      exhausted: page.exhausted,
    };
  },
});

/** Runs that are not terminal (for the Live Run picker), newest first. */
export const active = app.query({
  access: "runs.read",
  handler: async (ctx) => {
    const out = [];
    for (const state of ["running", "admitted", "requested"] as const) {
      const list = await ctx.db.find(runs, { state }, { orderBy: [{ field: "requestedAt", direction: "desc" }], limit: 50 });
      out.push(...list.map((r) => ({ runId: r.id, courseRef: r.courseRef, modelLabel: r.modelLabel, adapter: r.adapter, state: r.state, stage: r.stage ?? null, requestedAt: r.requestedAt, cancelRequested: r.cancelRequested })));
    }
    return out;
  },
});

export const get = app.query({
  access: "runs.read",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const r = await ctx.db.get(runs, runId);
    if (!r) fail("NOT_FOUND", "No such run.");
    const experiment = await ctx.db.get(experiments, r.experimentId);
    return { ...runView(r), experimentName: experiment?.name ?? null, experimentRevision: experiment?.revision ?? null };
  },
});

/** Events of a run in seq order: after `afterSeq` (paging forward) or the last `tail` events. Bounded. */
export const events = app.query({
  access: "runs.read",
  args: { runId: s.string(), afterSeq: s.optional(s.integer()), tail: s.optional(s.integer({ minimum: 1, maximum: 1000 })), limit: s.optional(s.integer({ minimum: 1, maximum: 1000 })) },
  handler: async (ctx, { runId, afterSeq, tail, limit }) => {
    const pick = (e: Record<string, any>) => ({ seq: e.seq as number, at: e.at as string, source: e.source as "agent" | "runtime" | "pax" | "evaluator" | "harness", kind: e.kind as string, summary: e.summary as string, data: (e.data ?? null) as unknown });
    if (tail !== undefined) {
      const page = await ctx.db.query(runEvents, { where: [{ field: "runId", eq: runId }], orderBy: [{ field: "seq", direction: "desc" }], limit: tail });
      return { events: page.records.map(pick).reverse(), hasEarlier: !page.exhausted };
    }
    const page = await ctx.db.query(runEvents, {
      where: [{ field: "runId", eq: runId }, ...(afterSeq !== undefined ? [{ field: "seq", gt: afterSeq }] : [])],
      orderBy: [{ field: "seq", direction: "asc" }],
      limit: limit ?? 500,
    });
    return { events: page.records.map(pick), hasEarlier: afterSeq !== undefined };
  },
});

/** The evidence index of a run (no content). */
export const evidenceIndex = app.query({
  access: "runs.read",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const items = await ctx.db.find(evidence, { runId }, { orderBy: [{ field: "receivedAt", direction: "asc" }], limit: 1000 });
    return items.map((e) => ({ evidenceId: e.evidenceId, kind: e.kind, label: e.label, source: e.source, digest: e.digest, size: e.size ?? null, path: e.path ?? null, hasContent: e.content !== undefined }));
  },
});

/** One evidence item's bounded content. Untrusted text: the UI renders it as text only. */
export const evidenceContent = app.query({
  access: "runs.read",
  args: { runId: s.string(), evidenceId: s.string() },
  handler: async (ctx, { runId, evidenceId }) => {
    const [e] = await ctx.db.find(evidence, { runId, evidenceId }, { limit: 1 });
    if (!e) fail("NOT_FOUND", "No such evidence item.");
    return { evidenceId, label: e.label, kind: e.kind, source: e.source, digest: e.digest, content: e.content ?? null, path: e.path ?? null };
  },
});

const MAX_COMPARE = 500;

/**
 * Comparison: runs of ONE course version, grouped by experiment revision. Separate
 * dimensions, no single score; anything a run did not report is "not observed".
 */
export const compare = app.query({
  access: "runs.read",
  args: { courseVersionId: s.optional(s.string()), runIds: s.optional(s.array(s.string(), { maxItems: 200 })) },
  handler: async (ctx, { courseVersionId, runIds }) => {
    let list: Record<string, any>[];
    let truncated = false;
    if (runIds?.length) {
      list = [];
      for (const id of runIds) {
        const r = await ctx.db.get(runs, id);
        if (!r) fail("NOT_FOUND", `No run ${id}.`);
        list.push(r);
      }
      const versionIds = new Set(list.map((r) => r.courseVersionId));
      if (courseVersionId) versionIds.add(courseVersionId);
      if (versionIds.size > 1) {
        fail("INVALID_ARGUMENT", "Comparison needs runs of one course version; these span several. Compare within a single course version.", { reason: "mixed_course_versions", courseVersionIds: [...versionIds] });
      }
      courseVersionId = list[0]!.courseVersionId;
    } else {
      if (!courseVersionId) fail("INVALID_ARGUMENT", "Choose a course version (or a set of runs of one course version).");
      list = await ctx.db.find(runs, { courseVersionId, state: "terminal" }, { orderBy: [{ field: "requestedAt", direction: "desc" }], limit: MAX_COMPARE });
      truncated = list.length === MAX_COMPARE;
    }
    const version = await ctx.db.get(courseVersions, courseVersionId!);
    if (!version) fail("NOT_FOUND", "No such course version.");
    const groups = new Map<string, Record<string, any>[]>();
    for (const r of list) groups.set(r.experimentId, [...(groups.get(r.experimentId) ?? []), r]);
    const out = [];
    for (const [experimentId, group] of groups) {
      const experiment = await ctx.db.get(experiments, experimentId);
      const terminal = group.filter((r) => r.state === "terminal");
      const results = terminal.map((r) => r.result as RunResult | undefined);
      const outcomes: Record<string, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, ERROR: 0, CANCELLED: 0 };
      for (const r of terminal) outcomes[r.outcome as string] = (outcomes[r.outcome as string] ?? 0) + 1;
      const decided = terminal.length - outcomes.CANCELLED!;
      const failureClasses: Record<string, number> = {};
      for (const res of results) if (res?.failureClass) failureClasses[res.failureClass] = (failureClasses[res.failureClass] ?? 0) + 1;
      const metricKeys = new Set<string>();
      for (const res of results) for (const k of Object.keys(res?.metrics ?? {})) metricKeys.add(k);
      const metrics: Record<string, ReturnType<typeof distribution>> = {};
      for (const k of [...metricKeys].sort()) metrics[k] = distribution(results.map((res) => res?.metrics?.[k] ?? null));
      let injected = 0;
      let recovered = 0;
      let notRecovered = 0;
      let unknownRecovery = 0;
      const violations = { attempted: 0, completed: 0, criticalCompleted: 0, bySeverity: { critical: 0, major: 0, minor: 0 } as Record<string, number> };
      for (const res of results) {
        for (const rec of res?.recovery ?? []) {
          if (!rec.injected) continue;
          injected += 1;
          if (rec.recovered === true) recovered += 1;
          else if (rec.recovered === false) notRecovered += 1;
          else unknownRecovery += 1;
        }
        for (const v of res?.evaluation.violations ?? []) {
          if (v.attempted) violations.attempted += 1;
          if (v.completed) violations.completed += 1;
          if (v.completed && v.severity === "critical") violations.criticalCompleted += 1;
          violations.bySeverity[v.severity] = (violations.bySeverity[v.severity] ?? 0) + 1;
        }
      }
      out.push({
        experimentId,
        experimentName: experiment?.name ?? experimentId,
        revision: experiment?.revision ?? null,
        digest: experiment?.digest ?? group[0]!.experimentDigest,
        modelLabel: group[0]!.modelLabel,
        adapter: group[0]!.adapter,
        runs: group.length,
        terminal: terminal.length,
        outcomes,
        verifiedCompletion: { pass: outcomes.PASS!, decided, rate: decided ? outcomes.PASS! / decided : null },
        checkPassRatio: distribution(results.map((res) => (res && res.evaluation.checks.length ? res.evaluation.checks.filter((c) => c.result === "pass").length / res.evaluation.checks.length : null))),
        durationMs: distribution(results.map((res) => res?.observed.durationMs ?? null)),
        metrics,
        recovery: { injected, recovered, notRecovered, unknown: unknownRecovery, rate: recovered + notRecovered ? recovered / (recovered + notRecovered) : null },
        violations,
        failureClasses,
        deterministic: results.filter((res) => res?.reproducibility.deterministic).length,
      });
    }
    out.sort((a, b) => a.experimentName.localeCompare(b.experimentName));
    return { courseVersionId: courseVersionId!, ref: version.ref, digest: version.digest, runCount: list.length, truncated, groups: out };
  },
});

/** Filter options for History (bounded). */
export const facets = app.query({
  access: "runs.read",
  handler: async (ctx) => {
    const recent = await ctx.db.query(runs, { orderBy: [{ field: "requestedAt", direction: "desc" }], limit: 500 });
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    return {
      adapters: uniq(recent.records.map((r) => r.adapter)),
      models: uniq(recent.records.map((r) => r.modelLabel)),
      courseVersions: uniq(recent.records.map((r) => `${r.courseVersionId}|${r.courseRef}`)).map((x) => ({ courseVersionId: x.split("|")[0]!, ref: x.split("|")[1]! })),
    };
  },
});
