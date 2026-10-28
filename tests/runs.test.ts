import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { definition, resultFor, sampleCourse, seed } from "./support.js";

const AUTHORITY = { url: "http://127.0.0.1:7791", namespace: "aoc", release: "feltdb-server 0.3.0" };
const harness = { id: "harness-key", type: "service" as const, roles: ["harness"] };

async function finish(t: Awaited<ReturnType<typeof createTestApp>>, runId: string, workloadId: string, overrides: Record<string, unknown> = {}) {
  const h = t.as(harness);
  const run = await t.as("ada").query(api.runs.get, { runId });
  await h.mutation(api.harness.admitted, { runId, workloadId, workAuthority: AUTHORITY });
  await h.mutation(api.harness.completed, resultFor({ runId, workloadId, courseDigest: run.courseDigest, experimentDigest: run.experimentDigest }, overrides) as any);
}

test("rerun creates a new run from the same experiment revision and course version", async () => {
  const t = await createTestApp();
  try {
    const { courseVersionId, experimentId, lineageId } = await seed(t);
    const grace = t.as("grace");
    const { runId } = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
    await finish(t, runId, "wl_a");
    // A newer revision and a newer course version exist; the rerun still pins the originals.
    await grace.mutation(api.experiments.save, { lineageId, name: "Stack-Agent + Qwen 3B", ...definition, budgets: { ...definition.budgets, maxTurns: 10 } });
    await t.as("ada").mutation(api.courses.publish, { course: sampleCourse({ version: "2.0.0" }) });
    const again = await grace.mutation(api.runs.rerun, { runId });
    const [a, b] = await Promise.all([grace.query(api.runs.get, { runId }), grace.query(api.runs.get, { runId: again.runId })]);
    assert.notEqual(b.runId, a.runId);
    assert.equal(b.rerunOf, a.runId);
    assert.equal(b.experimentId, a.experimentId);
    assert.equal(b.experimentDigest, a.experimentDigest);
    assert.deepEqual(b.experiment, a.experiment);
    assert.equal(b.courseVersionId, a.courseVersionId);
    assert.equal(b.courseDigest, a.courseDigest);
    assert.equal(b.state, "requested");
    const history = await grace.query(api.runs.list, { courseVersionId });
    assert.deepEqual(history.runs.map((r) => r.runId), [b.runId, a.runId]);
    assert.deepEqual((await grace.query(api.runs.list, { outcome: "PASS" })).runs.map((r) => r.runId), [a.runId]);
  } finally {
    await t.close();
  }
});

test("comparison is per course version, separates dimensions, and reports unknown metrics as not observed", async () => {
  const t = await createTestApp();
  try {
    const { courseVersionId, experimentId } = await seed(t);
    const grace = t.as("grace");
    const control = await grace.mutation(api.experiments.save, { name: "Reference control", ...definition, agent: { adapter: "reference-control" }, model: null });
    const r1 = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
    const r2 = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
    const r3 = await grace.mutation(api.runs.launch, { experimentId: control.experimentId, courseVersionId });
    await finish(t, r1.runId, "wl_1");
    await finish(t, r2.runId, "wl_2", {
      outcome: "FAIL",
      failureClass: "agent",
      evaluation: { evaluatorVersion: "aoc-evaluator 1.0.0", acceptance: "fail", checks: [{ id: "visible-tests", result: "pass" }, { id: "hidden-acceptance", result: "fail" }], violations: [] },
      metrics: { modelCalls: 20, toolExecutions: null },
      observed: { durationMs: 120_000, timedOut: false, exitCode: 0 },
    });
    await finish(t, r3.runId, "wl_3", { metrics: {}, recovery: [] });

    const cmp = await grace.query(api.runs.compare, { courseVersionId });
    assert.equal(cmp.runCount, 3);
    const stack = cmp.groups.find((g) => g.experimentId === experimentId)!;
    assert.deepEqual(stack.verifiedCompletion, { pass: 1, decided: 2, rate: 0.5 });
    assert.equal(stack.failureClasses.agent, 1);
    assert.equal(stack.durationMs.median, (81_000 + 120_000) / 2);
    assert.equal(stack.metrics.modelCalls!.observed, 2);
    assert.equal(stack.metrics.toolExecutions!.observed, 1);
    assert.equal(stack.metrics.toolExecutions!.notObserved, 1);
    assert.equal(stack.metrics.costUsd!.observed, 0); // null = not observed, never estimated
    assert.equal(stack.checkPassRatio.min, 0.5);
    const ref = cmp.groups.find((g) => g.experimentId === control.experimentId)!;
    assert.deepEqual(ref.metrics, {});
    assert.equal(ref.recovery.rate, null);

    // Mixed course versions are refused.
    const v2 = await t.as("ada").mutation(api.courses.publish, { course: sampleCourse({ version: "2.0.0" }) });
    const r4 = await grace.mutation(api.runs.launch, { experimentId, courseVersionId: v2.courseVersionId });
    await assert.rejects(grace.query(api.runs.compare, { runIds: [r1.runId, r4.runId] }), (e: any) => e.code === "INVALID_ARGUMENT" && e.details.reason === "mixed_course_versions");
    await assert.rejects(grace.query(api.runs.compare, { courseVersionId, runIds: [r4.runId] }), (e: any) => e.details.reason === "mixed_course_versions");
    const same = await grace.query(api.runs.compare, { runIds: [r1.runId, r3.runId] });
    assert.equal(same.groups.length, 2);
  } finally {
    await t.close();
  }
});

test("events are ordered by seq whatever the arrival order, paged, and bounded", async () => {
  const t = await createTestApp();
  try {
    const { courseVersionId, experimentId } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    const h = t.as(harness);
    await h.mutation(api.harness.admitted, { runId, workloadId: "wl_e", workAuthority: AUTHORITY });
    const ev = (seq: number) => ({ seq, at: new Date(Date.UTC(2026, 9, 28, 10, 0, seq)).toISOString(), source: "runtime" as const, kind: "tool.call", summary: `call ${seq}` });
    assert.deepEqual(await h.mutation(api.harness.eventsAppend, { runId, events: [ev(5), ev(3), ev(4)] }), { appended: 3 });
    assert.deepEqual(await h.mutation(api.harness.eventsAppend, { runId, events: [ev(0), ev(1), ev(2), ev(3)] }), { appended: 3 });
    // First write wins for a seq.
    assert.deepEqual(await h.mutation(api.harness.eventsAppend, { runId, events: [{ ...ev(1), summary: "rewritten" }] }), { appended: 0 });
    const viewer = t.as("linus");
    const all = await viewer.query(api.runs.events, { runId });
    assert.deepEqual(all.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
    assert.equal(all.events[1]!.summary, "call 1");
    assert.deepEqual((await viewer.query(api.runs.events, { runId, afterSeq: 3 })).events.map((e) => e.seq), [4, 5]);
    const tail = await viewer.query(api.runs.events, { runId, tail: 2 });
    assert.deepEqual(tail.events.map((e) => e.seq), [4, 5]);
    assert.equal(tail.hasEarlier, true);
    const run = await viewer.query(api.runs.get, { runId });
    assert.equal(run.lastSeq, 5);
    assert.equal(run.eventCount, 6);

    // Bounds: >200 per call, oversized data, bad timestamps, conflicting duplicates in one call.
    await assert.rejects(h.mutation(api.harness.eventsAppend, { runId, events: Array.from({ length: 201 }, (_, i) => ev(100 + i)) }));
    await assert.rejects(h.mutation(api.harness.eventsAppend, { runId, events: [{ ...ev(10), data: { blob: "x".repeat(17 * 1024) } }] }), { code: "PAYLOAD_TOO_LARGE" });
    await assert.rejects(h.mutation(api.harness.eventsAppend, { runId, events: [{ ...ev(11), at: "yesterday" }] }), (e: any) => e.details.reason === "invalid_time");
    await assert.rejects(h.mutation(api.harness.eventsAppend, { runId, events: [ev(12), { ...ev(12), summary: "different" }] }), (e: any) => e.details.reason === "duplicate_seq");
    await assert.rejects(
      h.mutation(api.harness.evidenceAdd, { runId, items: [{ evidenceId: "big", kind: "log", label: "big", source: "runtime", digest: "sha256:" + "0".repeat(64), content: "x".repeat(256 * 1024 + 1) }] }),
      { code: "PAYLOAD_TOO_LARGE" },
    );
    assert.equal((await viewer.query(api.runs.get, { runId })).eventCount, 6);
  } finally {
    await t.close();
  }
});

test("harness writes notify live queries (the change feed names the run collections)", async () => {
  const t = await createTestApp();
  try {
    const { courseVersionId, experimentId } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    const seen = new Set<string>();
    const off = t.runtime.changes.subscribe((event: { collections: string[] }) => event.collections.forEach((c) => seen.add(c)));
    try {
      const h = t.as(harness);
      await h.mutation(api.harness.admitted, { runId, workloadId: "wl_live", workAuthority: AUTHORITY });
      await h.mutation(api.harness.eventsAppend, { runId, events: [{ seq: 0, at: "2026-10-28T10:00:00Z", source: "runtime", kind: "stage", summary: "go" }] });
      for (let i = 0; i < 50 && !(seen.has("runs") && seen.has("runEvents")); i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      off();
    }
    assert.ok(seen.has("runs") || seen.has("*"), `changes: ${[...seen].join(",")}`);
    assert.ok(seen.has("runEvents") || seen.has("*"), `changes: ${[...seen].join(",")}`);
  } finally {
    await t.close();
  }
});

test("everything survives a restart", async () => {
  const t = await createTestApp();
  try {
    const { courseVersionId, courseDigest, experimentId, experimentDigest } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    await finish(t, runId, "wl_r");
    await t.restart();
    const ada = t.as("ada");
    const run = await ada.query(api.runs.get, { runId });
    assert.equal(run.outcome, "PASS");
    assert.equal(run.courseDigest, courseDigest);
    assert.equal(run.experimentDigest, experimentDigest);
    assert.equal((await ada.query(api.experiments.get, { experimentId })).digest, experimentDigest);
    assert.equal((await ada.query(api.courses.get, { courseVersionId })).status, "published");
    // Immutability holds after a restart too.
    await assert.rejects(ada.mutation(api.courses.publish, { course: sampleCourse({ acceptance: "changed" }) }), (e: any) => e.details.reason === "immutable_version");
  } finally {
    await t.close();
  }
});
