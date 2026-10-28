/**
 * The harness ↔ app contract (docs/contracts/harness-app.md).
 *
 * Every function here is an AppPort capability authorized by a `harness.*` permission,
 * which only the `harness` role (AppPort Services API keys) and `admin` hold. They are the
 * only way a run projection changes after it was requested. Every mutation is idempotent:
 * a replay of the same report is answered `ok` without changing anything, and a report
 * that contradicts what is recorded is refused (INVALID_INPUT with details.reason), never
 * merged. FeltDB commit conflicts surface as CONFLICT and are safe to retry.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { app, courseVersions, evidence, runEvents, runs } from "./app.js";
import { byteLength, canonicalJson, normalizeDigest, sha256Hex } from "./lib/canonical.js";
import { CourseVersionOut, EvidenceItem, Ok, PendingRun, RunEvent, RunResultShape } from "./lib/schemas.js";
import type { RunResult, StageEntry } from "./runs.js";

export const LIMITS = {
  pendingDefault: 20,
  pendingMax: 100,
  eventsPerCall: 200,
  eventsPerRun: 20_000,
  eventDataBytes: 16 * 1024,
  evidencePerCall: 50,
  evidencePerRun: 2_000,
  evidenceContentBytes: 256 * 1024,
  stagesPerRun: 200,
  detailBytes: 8 * 1024,
  resultBytes: 256 * 1024,
} as const;

function refuse(reason: string, message: string, details: Record<string, unknown> = {}): never {
  fail("INVALID_ARGUMENT", message, { reason, ...details });
}

function isoMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(ms)) refuse("invalid_time", `${field} must be an ISO-8601 timestamp.`, { field });
  return ms;
}

function boundedJson(value: unknown, max: number, field: string): void {
  if (value === undefined) return;
  let size: number;
  try {
    size = byteLength(canonicalJson(value));
  } catch {
    refuse("invalid_json", `${field} must be plain JSON.`, { field });
  }
  if (size > max) fail("PAYLOAD_TOO_LARGE", `${field} is ${size} bytes; the limit is ${max}.`, { reason: "too_large", field, limit: max });
}

async function requireRun(ctx: QueryCtx | MutationCtx, runId: string) {
  const run = await ctx.db.get(runs, runId);
  if (!run) fail("NOT_FOUND", `No run ${runId}.`, { reason: "unknown_run" });
  return run;
}

/** runs.pending@1 — runs in state `requested` without a workload, oldest first. */
export const pending = app.query({
  access: "harness.runs.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: LIMITS.pendingMax })) },
  returns: s.object({ runs: s.array(PendingRun) }),
  capability: { name: "runs.pending", description: "Runs requested and not yet admitted (no workload), oldest first." },
  handler: async (ctx, { limit }) => {
    const list = await ctx.db.find(runs, { state: "requested" }, { orderBy: [{ field: "requestedAt", direction: "asc" }], limit: limit ?? LIMITS.pendingDefault });
    return {
      runs: list
        .filter((r) => !r.workloadId && !r.cancelRequested)
        .map((r) => ({
          runId: r.id,
          courseVersionId: r.courseVersionId,
          courseDigest: r.courseDigest,
          experiment: r.experiment as never,
          requestedAt: new Date(r.requestedAt).toISOString(),
          requestedBy: r.requestedBy,
        })),
    };
  },
});

/** runs.cancellations@1 — cancel requested for an admitted workload, not yet reported terminal. */
export const cancellations = app.query({
  access: "harness.runs.read",
  returns: s.object({ runs: s.array(s.object({ runId: s.string(), workloadId: s.string() })) }),
  capability: { name: "runs.cancellations", description: "Runs whose cancel was requested and whose workload has not been reported terminal." },
  handler: async (ctx) => {
    const list = await ctx.db.find(runs, { cancelPending: true }, { orderBy: [{ field: "requestedAt", direction: "asc" }], limit: 200 });
    return { runs: list.filter((r) => r.workloadId).map((r) => ({ runId: r.id, workloadId: r.workloadId! })) };
  },
});

/** courses.version@1 — an immutable course version with its digest and document. */
export const courseVersion = app.query({
  access: "harness.courses.read",
  args: { courseVersionId: s.string() },
  returns: s.object({ version: CourseVersionOut }),
  capability: { name: "courses.version", description: "One course version (immutable once published), with its digest and course.json document." },
  handler: async (ctx, { courseVersionId }) => {
    const v = await ctx.db.get(courseVersions, courseVersionId);
    if (!v) fail("NOT_FOUND", "No such course version.", { reason: "unknown_course_version" });
    return {
      version: {
        courseVersionId: v.id,
        courseId: v.courseId,
        version: v.version,
        ref: v.ref,
        status: v.status,
        digest: v.digest,
        publishedAt: v.publishedAt ? new Date(v.publishedAt).toISOString() : null,
        spec: v.spec,
      },
    };
  },
});

/** runs.admitted@1 — the dispatcher admitted one Durable Work workload for the run. */
export const admitted = app.mutation({
  access: "harness.runs.write",
  args: {
    runId: s.string(),
    workloadId: s.string({ minLength: 1, maxLength: 200 }),
    workAuthority: s.object({ url: s.string({ maxLength: 500 }), namespace: s.string({ maxLength: 200 }), release: s.string({ maxLength: 80 }) }),
  },
  returns: Ok,
  capability: { name: "runs.admitted", description: "Record the Durable Work workload admitted for a run. Idempotent; a different workloadId for the same run is refused." },
  handler: async (ctx, { runId, workloadId, workAuthority }) => {
    const run = await requireRun(ctx, runId);
    if (run.workloadId) {
      if (run.workloadId !== workloadId) refuse("workload_mismatch", `Run ${runId} is already bound to workload ${run.workloadId}.`, { workloadId: run.workloadId });
      return { ok: true as const };
    }
    const now = Date.now();
    if (run.state === "requested") {
      await ctx.db.patch(runs, runId, { state: "admitted", workloadId, workAuthority, admittedAt: now, updatedAt: now });
    } else if (run.state === "terminal" && run.cancelledBeforeAdmission) {
      // The person cancelled before admission, but the dispatcher had already admitted a
      // workload: bind it so the harness's cancellation loop cancels it.
      await ctx.db.patch(runs, runId, { workloadId, workAuthority, admittedAt: now, cancelPending: true, updatedAt: now });
    } else {
      refuse("invalid_state", `Run ${runId} is ${run.state}; it cannot be admitted.`);
    }
    return { ok: true as const };
  },
});

/** runs.stage@1 — a stage started, completed or failed (fenced by the authority's claim). */
export const stage = app.mutation({
  access: "harness.runs.write",
  args: {
    runId: s.string(),
    workloadId: s.string(),
    attemptNumber: s.integer({ minimum: 1 }),
    fencingToken: s.integer({ minimum: 0 }),
    stage: s.string({ minLength: 1, maxLength: 64 }),
    status: s.enum(["started", "completed", "failed"]),
    at: s.string(),
    detail: s.optional(s.unknown()),
  },
  returns: Ok,
  capability: { name: "runs.stage", description: "Report a stage transition. Idempotent on (stage, status, attemptNumber, fencingToken); a lower fencing token than recorded is refused." },
  handler: async (ctx, input) => {
    const run = await requireRun(ctx, input.runId);
    isoMs(input.at, "at");
    boundedJson(input.detail, LIMITS.detailBytes, "detail");
    if (!run.workloadId) refuse("not_admitted", `Run ${input.runId} has no workload yet; report runs.admitted first.`);
    if (run.workloadId !== input.workloadId) refuse("workload_mismatch", `Run ${input.runId} is bound to workload ${run.workloadId}.`, { workloadId: run.workloadId });
    const stages = run.stages as StageEntry[];
    const duplicate = stages.find((e) => e.stage === input.stage && e.status === input.status && e.attemptNumber === input.attemptNumber && e.fencingToken === input.fencingToken);
    if (duplicate) return { ok: true as const };
    if (run.fencingToken !== undefined && input.fencingToken < run.fencingToken) {
      refuse("stale_fencing_token", `Fencing token ${input.fencingToken} is older than the recorded ${run.fencingToken}; a newer attempt holds the workload.`, { fencingToken: run.fencingToken });
    }
    if (run.state === "terminal") refuse("run_terminal", `Run ${input.runId} already finished (${run.outcome}).`);
    if (stages.length >= LIMITS.stagesPerRun) fail("PAYLOAD_TOO_LARGE", `Run ${input.runId} has ${stages.length} stage reports; the limit is ${LIMITS.stagesPerRun}.`, { reason: "too_many_stages" });
    const entry: StageEntry = {
      stage: input.stage,
      status: input.status,
      at: input.at,
      attemptNumber: input.attemptNumber,
      fencingToken: input.fencingToken,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    const now = Date.now();
    await ctx.db.patch(runs, input.runId, {
      state: "running",
      stage: input.stage,
      stageStatus: input.status,
      stages: [...stages, entry],
      attemptNumber: input.attemptNumber,
      fencingToken: input.fencingToken,
      ...(run.startedAt ? {} : { startedAt: now }),
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

/** runs.events.append@1 — up to 200 events; first write wins for each (runId, seq). */
export const eventsAppend = app.mutation({
  access: "harness.runs.write",
  args: { runId: s.string(), events: s.array(RunEvent, { maxItems: LIMITS.eventsPerCall }) },
  returns: s.object({ appended: s.integer() }),
  capability: { name: "runs.events.append", description: "Append run events (at most 200 per call). Idempotent on (runId, seq)." },
  handler: async (ctx, { runId, events }) => {
    const run = await requireRun(ctx, runId);
    if (!events.length) return { appended: 0 };
    const bySeq = new Map<number, (typeof events)[number]>();
    for (const e of events) {
      isoMs(e.at, `events[seq=${e.seq}].at`);
      boundedJson(e.data, LIMITS.eventDataBytes, `events[seq=${e.seq}].data`);
      const prior = bySeq.get(e.seq);
      if (prior && canonicalJson(prior) !== canonicalJson(e)) refuse("duplicate_seq", `seq ${e.seq} appears twice in this call with different content.`, { seq: e.seq });
      bySeq.set(e.seq, e);
    }
    const seqs = [...bySeq.keys()].sort((a, b) => a - b);
    const existing = await ctx.db.query(runEvents, {
      where: [{ field: "runId", eq: runId }, { field: "seq", gte: seqs[0]! }, { field: "seq", lte: seqs[seqs.length - 1]! }],
      orderBy: [{ field: "seq", direction: "asc" }],
      limit: Math.min(10_000, seqs[seqs.length - 1]! - seqs[0]! + 1),
    });
    const present = new Set(existing.records.map((e) => e.seq));
    const fresh = seqs.filter((seq) => !present.has(seq));
    if (run.eventCount + fresh.length > LIMITS.eventsPerRun) {
      fail("PAYLOAD_TOO_LARGE", `Run ${runId} would exceed ${LIMITS.eventsPerRun} events.`, { reason: "too_many_events", limit: LIMITS.eventsPerRun });
    }
    const now = Date.now();
    for (const seq of fresh) {
      const e = bySeq.get(seq)!;
      await ctx.db.insert(runEvents, { runId, seq, at: e.at, source: e.source, kind: e.kind, summary: e.summary, ...(e.data !== undefined ? { data: e.data } : {}), receivedAt: now });
    }
    if (fresh.length) {
      await ctx.db.patch(runs, runId, { lastSeq: Math.max(run.lastSeq, fresh[fresh.length - 1]!), eventCount: run.eventCount + fresh.length, updatedAt: now });
    }
    return { appended: fresh.length };
  },
});

/** runs.evidence.add@1 — evidence index entries; first write wins for each (runId, evidenceId). */
export const evidenceAdd = app.mutation({
  access: "harness.runs.write",
  args: { runId: s.string(), items: s.array(EvidenceItem, { maxItems: LIMITS.evidencePerCall }) },
  returns: s.object({ added: s.integer() }),
  capability: { name: "runs.evidence.add", description: "Add evidence items (content ≤ 256 KiB, digest = sha256 of content). Idempotent on (runId, evidenceId); a different digest for a recorded id is refused." },
  handler: async (ctx, { runId, items }) => {
    const run = await requireRun(ctx, runId);
    const now = Date.now();
    const seen = new Map<string, string>();
    let added = 0;
    for (const item of items) {
      const digest = normalizeDigest(item.digest);
      if (!digest) refuse("invalid_digest", `Evidence ${item.evidenceId}: digest must be sha256:<64 hex> (or 64 hex).`, { evidenceId: item.evidenceId });
      if (item.content !== undefined) {
        const size = byteLength(item.content);
        if (size > LIMITS.evidenceContentBytes) {
          fail("PAYLOAD_TOO_LARGE", `Evidence ${item.evidenceId} content is ${size} bytes; the limit is ${LIMITS.evidenceContentBytes}. Reference larger artifacts by path + digest.`, { reason: "too_large", evidenceId: item.evidenceId });
        }
        const actual = `sha256:${sha256Hex(item.content)}`;
        if (actual !== digest) refuse("digest_mismatch", `Evidence ${item.evidenceId}: digest does not match its content (${actual}).`, { evidenceId: item.evidenceId, computed: actual });
      } else if (!item.path) {
        refuse("no_content", `Evidence ${item.evidenceId} has neither content nor path.`, { evidenceId: item.evidenceId });
      }
      if (seen.has(item.evidenceId)) {
        if (seen.get(item.evidenceId) !== digest) refuse("evidence_conflict", `Evidence ${item.evidenceId} appears twice with different digests.`, { evidenceId: item.evidenceId });
        continue;
      }
      seen.set(item.evidenceId, digest);
      const [existing] = await ctx.db.find(evidence, { runId, evidenceId: item.evidenceId }, { limit: 1 });
      if (existing) {
        if (existing.digest !== digest) refuse("evidence_conflict", `Evidence ${item.evidenceId} is already recorded with digest ${existing.digest}.`, { evidenceId: item.evidenceId, digest: existing.digest });
        continue;
      }
      await ctx.db.insert(evidence, {
        runId,
        evidenceId: item.evidenceId,
        kind: item.kind,
        label: item.label,
        source: item.source,
        digest,
        ...(item.content !== undefined ? { content: item.content, size: byteLength(item.content) } : {}),
        ...(item.path ? { path: item.path } : {}),
        receivedAt: now,
      });
      added += 1;
    }
    if (run.evidenceCount + added > LIMITS.evidencePerRun) fail("PAYLOAD_TOO_LARGE", `Run ${runId} would exceed ${LIMITS.evidencePerRun} evidence items.`, { reason: "too_much_evidence" });
    if (added) await ctx.db.patch(runs, runId, { evidenceCount: run.evidenceCount + added, updatedAt: now });
    return { added };
  },
});

/** The app's own consistency rules for a result (defense in depth; the evaluator applies them first). */
export function inconsistencies(result: RunResult): string[] {
  const problems: string[] = [];
  const criticalCompleted = result.evaluation.violations.filter((v) => v.severity === "critical" && v.completed);
  if (result.outcome === "PASS") {
    if (result.evaluation.acceptance !== "pass") problems.push(`PASS needs evaluation.acceptance "pass" (got "${result.evaluation.acceptance}")`);
    if (criticalCompleted.length) problems.push(`PASS is impossible with a completed critical violation (${criticalCompleted.map((v) => v.id).join(", ")})`);
    if (result.failureClass) problems.push("PASS cannot carry a failureClass");
  }
  for (const v of result.evaluation.violations) if (v.completed && !v.attempted) problems.push(`violation ${v.id} is completed but not attempted`);
  if (result.reproducibility.evaluatorVersion !== result.evaluation.evaluatorVersion) problems.push("reproducibility.evaluatorVersion differs from evaluation.evaluatorVersion");
  for (const r of result.recovery) if (!r.injected && (r.recovered === true || r.recognized === true)) problems.push(`recovery ${r.obstacleId ?? "?"} reports recognition/recovery of an obstacle that was not injected`);
  return problems;
}

/** runs.completed@1 — the terminal result. Idempotent; a second, different result is refused. */
export const completed = app.mutation({
  access: "harness.runs.write",
  args: RunResultShape,
  returns: Ok,
  capability: {
    name: "runs.completed",
    description: "Report the run's terminal result. Refused unless consistent (no PASS without evaluator acceptance pass and no completed critical violation). Idempotent; a different second result is refused.",
  },
  handler: async (ctx, input) => {
    const result = input as RunResult;
    const run = await requireRun(ctx, result.runId);
    boundedJson(result, LIMITS.resultBytes, "result");
    const started = isoMs(result.startedAt, "startedAt");
    const finished = isoMs(result.completedAt, "completedAt");
    if (finished < started) refuse("invalid_time", "completedAt is before startedAt.");
    if (run.result) {
      if (canonicalJson(run.result) === canonicalJson(result)) return { ok: true as const };
      refuse("result_conflict", `Run ${result.runId} already has a different result (${run.outcome}). A run has exactly one result.`, { outcome: run.outcome });
    }
    if (!run.workloadId) refuse("not_admitted", `Run ${result.runId} has no workload; a result needs runs.admitted first.`);
    if (run.workloadId !== result.workloadId) refuse("workload_mismatch", `Run ${result.runId} is bound to workload ${run.workloadId}.`, { workloadId: run.workloadId });
    if (run.cancelledBeforeAdmission && result.outcome !== "CANCELLED") {
      refuse("result_conflict", `Run ${result.runId} was cancelled before admission; only a CANCELLED result can be recorded.`, { outcome: "CANCELLED" });
    }
    if (normalizeDigest(result.reproducibility.courseDigest) !== run.courseDigest) {
      refuse("course_digest_mismatch", `reproducibility.courseDigest does not match the run's course version (${run.courseDigest}).`, { courseDigest: run.courseDigest });
    }
    if (normalizeDigest(result.reproducibility.experimentDigest) !== run.experimentDigest) {
      refuse("experiment_digest_mismatch", `reproducibility.experimentDigest does not match the run's experiment (${run.experimentDigest}).`, { experimentDigest: run.experimentDigest });
    }
    const problems = inconsistencies(result);
    if (problems.length) refuse("inconsistent_result", `Inconsistent result refused: ${problems.join("; ")}.`, { problems });
    const now = Date.now();
    await ctx.db.patch(runs, result.runId, {
      state: "terminal",
      outcome: result.outcome,
      outcomeKey: result.outcome,
      result,
      cancelPending: false,
      terminalAt: run.terminalAt ?? now,
      updatedAt: now,
    });
    return { ok: true as const };
  },
});
