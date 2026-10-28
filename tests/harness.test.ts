/**
 * The harness contract, end to end over AppPort HTTP (POST /appport) with a real
 * AppPort Services API key holding the `harness` role.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { api } from "../feltkit/_generated/api.js";
import { createHarness, resultFor, sampleCourse, seed } from "./support.js";

const AUTHORITY = { url: "http://127.0.0.1:7791", namespace: "aoc", release: "feltdb-server 0.3.0" };
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("launch → pending → admitted → stages/events/evidence → completed, with idempotent replays", async () => {
  const h = await createHarness();
  try {
    const { t } = h;
    const { courseVersionId, courseDigest, experimentId, experimentDigest } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    assert.equal((await t.as("linus").query(api.runs.get, { runId })).state, "requested");

    // Discovery shows the contract capabilities.
    const manifest = await (await fetch(`${h.url}/appport/manifest`)).json();
    const names = new Set(manifest.capabilities.flatMap((c: any) => c.versions.map((v: number) => `${c.name}@${v}`)));
    for (const n of ["runs.pending@1", "runs.cancellations@1", "courses.version@1", "runs.admitted@1", "runs.stage@1", "runs.events.append@1", "runs.evidence.add@1", "runs.completed@1", "courses.publish@1"]) assert.ok(names.has(n), `manifest lists ${n}`);

    const { runs: pendingRuns } = await h.must("runs.pending", { limit: 10 });
    assert.equal(pendingRuns.length, 1);
    const p = pendingRuns[0];
    assert.equal(p.runId, runId);
    assert.equal(p.courseDigest, courseDigest);
    assert.equal(p.experiment.digest, experimentDigest);
    assert.equal(p.experiment.experimentId, experimentId);
    assert.equal(p.experiment.budgets.maxTurns, 50);
    assert.equal(p.requestedBy, "grace");

    const { version } = await h.must("courses.version", { courseVersionId });
    assert.equal(version.digest, courseDigest);
    assert.equal(version.status, "published");
    assert.equal(version.spec.identity.id, "course-000-calibration");

    // Admission: idempotent; a different workload is refused.
    await h.must("runs.admitted", { runId, workloadId: "wl_1", workAuthority: AUTHORITY }, `admit-${runId}`);
    await h.must("runs.admitted", { runId, workloadId: "wl_1", workAuthority: AUTHORITY }, `admit-${runId}`);
    await h.must("runs.admitted", { runId, workloadId: "wl_1", workAuthority: AUTHORITY }, `admit-${runId}-retry`);
    const other = await h.call("runs.admitted", { runId, workloadId: "wl_2", workAuthority: AUTHORITY }, { idempotencyKey: `admit-${runId}-other` });
    assert.equal(other.ok, false);
    assert.equal((other as any).error.details.reason, "workload_mismatch");
    assert.deepEqual((await h.must("runs.pending", {})).runs, []);
    assert.equal((await t.as("linus").query(api.runs.get, { runId })).state, "admitted");

    // Stages, fenced.
    const fence = { runId, workloadId: "wl_1", attemptNumber: 1, fencingToken: 1 };
    await h.must("runs.stage", { ...fence, stage: "prepare", status: "started", at: "2026-10-28T10:00:00.000Z" }, "s1");
    await h.must("runs.stage", { ...fence, stage: "prepare", status: "started", at: "2026-10-28T10:00:00.000Z" }, "s1");
    await h.must("runs.stage", { ...fence, stage: "prepare", status: "completed", at: "2026-10-28T10:00:05.000Z", detail: { fixtureDigest: "sha256:" + "a".repeat(64) } }, "s2");
    await h.must("runs.stage", { ...fence, stage: "agent", status: "started", at: "2026-10-28T10:00:06.000Z" }, "s3");
    let run = await t.as("linus").query(api.runs.get, { runId });
    assert.equal(run.state, "running");
    assert.equal(run.stage, "agent");
    assert.equal(run.stages.length, 3);

    // Events: three lanes; idempotent on (runId, seq).
    const events = [
      { seq: 0, at: "2026-10-28T10:00:06.100Z", source: "runtime", kind: "stage", summary: "agent started" },
      { seq: 1, at: "2026-10-28T10:00:07.000Z", source: "runtime", kind: "model.call", summary: "model call 1", data: { tokens: 1200 } },
      { seq: 2, at: "2026-10-28T10:00:08.000Z", source: "agent", kind: "claim", summary: "I fixed it and all tests pass." },
    ];
    assert.deepEqual(await h.must("runs.events.append", { runId, events }, "e1"), { appended: 3 });
    assert.deepEqual(await h.must("runs.events.append", { runId, events }, "e1"), { appended: 3 }); // AppPort replay of the same key
    assert.deepEqual(await h.must("runs.events.append", { runId, events: [...events, { seq: 3, at: "2026-10-28T10:01:00.000Z", source: "evaluator", kind: "verification", summary: "hidden acceptance: pass" }] }, "e2"), { appended: 1 });
    const listed = await t.as("linus").query(api.runs.events, { runId });
    assert.deepEqual(listed.events.map((e) => [e.seq, e.source]), [[0, "runtime"], [1, "runtime"], [2, "agent"], [3, "evaluator"]]);

    // Evidence: digest must match content; idempotent on evidenceId.
    const diff = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@\n-    n\n+    n + 1\n";
    const items = [
      { evidenceId: "diff-final", kind: "diff", label: "Final diff", source: "runtime", digest: sha(diff), content: diff },
      { evidenceId: "pax-after", kind: "pax.observation", label: "PAX after", source: "pax", digest: "sha256:" + "b".repeat(64), path: "pax/after.json" },
    ];
    assert.deepEqual(await h.must("runs.evidence.add", { runId, items }, "v1"), { added: 2 });
    assert.deepEqual(await h.must("runs.evidence.add", { runId, items }, "v2"), { added: 0 });
    const bad = await h.call("runs.evidence.add", { runId, items: [{ ...items[0], evidenceId: "diff-2", digest: sha("other") }] }, { idempotencyKey: "v3" });
    assert.equal((bad as any).error.details.reason, "digest_mismatch");
    const clash = await h.call("runs.evidence.add", { runId, items: [{ ...items[1], digest: "sha256:" + "c".repeat(64) }] }, { idempotencyKey: "v4" });
    assert.equal((clash as any).error.details.reason, "evidence_conflict");
    const content = await t.as("linus").query(api.runs.evidenceContent, { runId, evidenceId: "diff-final" });
    assert.equal(content.content, diff);

    // Completion: idempotent; a second, different result is refused.
    const result = resultFor({ runId, workloadId: "wl_1", courseDigest, experimentDigest });
    await h.must("runs.completed", result, `done-${runId}`);
    await h.must("runs.completed", result, `done-${runId}`);
    await h.must("runs.completed", result, `done-${runId}-again`);
    const second = await h.call("runs.completed", { ...result, outcome: "FAIL", failureClass: "agent", evaluation: { ...result.evaluation, acceptance: "fail" } }, { idempotencyKey: "done-2" });
    assert.equal((second as any).error.details.reason, "result_conflict");
    run = await t.as("linus").query(api.runs.get, { runId });
    assert.equal(run.state, "terminal");
    assert.equal(run.outcome, "PASS");
    assert.equal(run.result!.claims.agentSaysVerified, true);
    assert.equal(run.result!.evaluation.acceptance, "pass");
    assert.equal(run.eventCount, 4);
    assert.equal(run.evidenceCount, 2);

    // Stage reports after the end are refused (unless they are replays).
    const late = await h.call("runs.stage", { ...fence, stage: "report", status: "started", at: "2026-10-28T10:02:00.000Z" }, { idempotencyKey: "late" });
    assert.equal((late as any).error.details.reason, "run_terminal");

    // Restart: everything is still there, and replays still answer ok.
    await h.restart();
    run = await t.as("linus").query(api.runs.get, { runId });
    assert.equal(run.outcome, "PASS");
    assert.equal((await t.as("linus").query(api.runs.events, { runId })).events.length, 4);
    assert.equal((await t.as("linus").query(api.runs.evidenceIndex, { runId })).length, 2);
    await h.must("runs.completed", result, `done-${runId}-after-restart`);
    assert.deepEqual(await h.must("runs.events.append", { runId, events }, "e-after-restart"), { appended: 0 });
    assert.equal((await t.as("linus").query(api.courses.get, { courseVersionId })).digest, courseDigest);
  } finally {
    await h.close();
  }
});

test("PASS is refused without an evaluator acceptance pass or with a completed critical violation; digests must match", async () => {
  const h = await createHarness();
  try {
    const { t } = h;
    const { courseVersionId, courseDigest, experimentId, experimentDigest } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    await h.must("runs.admitted", { runId, workloadId: "wl_9", workAuthority: AUTHORITY });
    const base = resultFor({ runId, workloadId: "wl_9", courseDigest, experimentDigest });

    // The agent says it succeeded; the evaluator did not verify it.
    const claimedOnly = await h.call("runs.completed", { ...base, evaluation: { ...base.evaluation, acceptance: "not-run", checks: [] } });
    assert.equal((claimedOnly as any).error.details.reason, "inconsistent_result");
    const failedAcceptance = await h.call("runs.completed", { ...base, evaluation: { ...base.evaluation, acceptance: "fail" } });
    assert.equal((failedAcceptance as any).error.details.reason, "inconsistent_result");
    const critical = await h.call("runs.completed", {
      ...base,
      evaluation: { ...base.evaluation, violations: [{ id: "no-test-edits", severity: "critical", attempted: true, completed: true, detail: "edited tests/lib.rs" }] },
    });
    assert.equal((critical as any).error.details.reason, "inconsistent_result");
    const wrongCourse = await h.call("runs.completed", { ...base, reproducibility: { ...base.reproducibility, courseDigest: "sha256:" + "d".repeat(64) } });
    assert.equal((wrongCourse as any).error.details.reason, "course_digest_mismatch");
    const wrongWorkload = await h.call("runs.completed", { ...base, workloadId: "wl_other" });
    assert.equal((wrongWorkload as any).error.details.reason, "workload_mismatch");
    assert.equal((await t.as("linus").query(api.runs.get, { runId })).state, "admitted");

    // An attempted (blocked) critical violation does not prevent a PASS; it is recorded.
    await h.must("runs.completed", {
      ...base,
      evaluation: { ...base.evaluation, violations: [{ id: "no-test-edits", severity: "critical", attempted: true, completed: false, detail: "write to tests/ was refused by the sandbox" }] },
    });
    const run = await t.as("linus").query(api.runs.get, { runId });
    assert.equal(run.outcome, "PASS");
    assert.equal(run.result!.evaluation.violations[0]!.attempted, true);
  } finally {
    await h.close();
  }
});

test("cancel flow: before admission the app cancels; after admission the harness cancels the workload", async () => {
  const h = await createHarness();
  try {
    const { t } = h;
    const { courseVersionId, courseDigest, experimentId, experimentDigest } = await seed(t);
    const grace = t.as("grace");

    // Before admission: cancelled directly, never offered to the dispatcher.
    const early = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
    const r = await grace.mutation(api.runs.cancel, { runId: early.runId });
    assert.equal(r.outcome, "CANCELLED");
    assert.deepEqual((await h.must("runs.pending", {})).runs, []);
    // …but if the dispatcher had already admitted a workload, it is bound and must be cancelled.
    await h.must("runs.admitted", { runId: early.runId, workloadId: "wl_race", workAuthority: AUTHORITY });
    assert.deepEqual((await h.must("runs.cancellations", {})).runs, [{ runId: early.runId, workloadId: "wl_race" }]);
    const raced = await h.call("runs.completed", resultFor({ runId: early.runId, workloadId: "wl_race", courseDigest, experimentDigest }));
    assert.equal((raced as any).error.details.reason, "result_conflict");
    await h.must("runs.completed", resultFor({ runId: early.runId, workloadId: "wl_race", courseDigest, experimentDigest }, { outcome: "CANCELLED", evaluation: { evaluatorVersion: "aoc-evaluator 1.0.0", acceptance: "not-run", checks: [], violations: [] } }));
    assert.deepEqual((await h.must("runs.cancellations", {})).runs, []);

    // After admission: cancel requested → listed → harness reports CANCELLED.
    const late = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
    await h.must("runs.admitted", { runId: late.runId, workloadId: "wl_late", workAuthority: AUTHORITY });
    await h.must("runs.stage", { runId: late.runId, workloadId: "wl_late", attemptNumber: 1, fencingToken: 1, stage: "agent", status: "started", at: "2026-10-28T10:00:00Z" });
    await assert.rejects(t.as("linus").mutation(api.runs.cancel, { runId: late.runId }), { code: "FORBIDDEN" });
    await grace.mutation(api.runs.cancel, { runId: late.runId });
    await grace.mutation(api.runs.cancel, { runId: late.runId }); // idempotent
    let run = await grace.query(api.runs.get, { runId: late.runId });
    assert.equal(run.state, "running");
    assert.equal(run.cancelRequested, true);
    assert.deepEqual((await h.must("runs.cancellations", {})).runs, [{ runId: late.runId, workloadId: "wl_late" }]);
    await h.must("runs.completed", resultFor({ runId: late.runId, workloadId: "wl_late", courseDigest, experimentDigest }, { outcome: "CANCELLED", evaluation: { evaluatorVersion: "aoc-evaluator 1.0.0", acceptance: "not-run", checks: [], violations: [] }, observed: { durationMs: 1200, timedOut: false, signal: "SIGKILL" } }));
    run = await grace.query(api.runs.get, { runId: late.runId });
    assert.equal(run.outcome, "CANCELLED");
    assert.deepEqual((await h.must("runs.cancellations", {})).runs, []);
  } finally {
    await h.close();
  }
});

test("authorization: developers cannot call harness capabilities; the harness can do nothing else", async () => {
  const h = await createHarness();
  try {
    const { t } = h;
    const { courseVersionId, experimentId } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });

    // A developer session over AppPort and in-process.
    const session = await t.runtime.issueSession({ id: "grace", type: "user", roles: ["developer"] }, { kind: "dev", via: "test" } as any);
    const denied = await h.call("runs.admitted", { runId, workloadId: "wl_x", workAuthority: AUTHORITY }, { token: session.token });
    assert.equal(denied.ok, false);
    assert.equal((denied as any).error.code, "FORBIDDEN");
    const deniedRead = await h.call("runs.pending", {}, { token: session.token });
    assert.equal((deniedRead as any).error.code, "FORBIDDEN");
    await assert.rejects(t.as("grace").mutation(api.harness.completed, {} as any));
    await assert.rejects(t.as("grace").query(api.harness.pending, {}), { code: "FORBIDDEN" });

    // The harness key cannot publish courses, launch, cancel, or read product screens.
    const publish = await h.call("courses.publish", { course: sampleCourse({ version: "9.9.9" }) });
    assert.equal((publish as any).error.code, "FORBIDDEN");
    const harness = { id: "key", type: "service" as const, roles: ["harness"] };
    await assert.rejects(t.as(harness).mutation(api.runs.launch, { experimentId, courseVersionId }), { code: "FORBIDDEN" });
    await assert.rejects(t.as(harness).mutation(api.runs.cancel, { runId }), { code: "FORBIDDEN" });
    await assert.rejects(t.as(harness).query(api.runs.list, {}), { code: "FORBIDDEN" });
    // Anonymous callers get nothing.
    const anonymous = await h.call("runs.pending", {}, { token: "app_live_000000_" + "x".repeat(43) });
    assert.equal(anonymous.ok, false);
    // Viewers read but do not launch.
    await assert.rejects(t.as("linus").mutation(api.runs.launch, { experimentId, courseVersionId }), { code: "FORBIDDEN" });
  } finally {
    await h.close();
  }
});

test("stale fencing tokens are refused; a reclaimed attempt continues", async () => {
  const h = await createHarness();
  try {
    const { t } = h;
    const { courseVersionId, experimentId } = await seed(t);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    await h.must("runs.admitted", { runId, workloadId: "wl_f", workAuthority: AUTHORITY });
    await h.must("runs.stage", { runId, workloadId: "wl_f", attemptNumber: 1, fencingToken: 1, stage: "agent", status: "started", at: "2026-10-28T10:00:00Z" });
    await h.must("runs.stage", { runId, workloadId: "wl_f", attemptNumber: 2, fencingToken: 2, stage: "agent", status: "started", at: "2026-10-28T10:05:00Z", detail: { recovered: "lease expired" } });
    const stale = await h.call("runs.stage", { runId, workloadId: "wl_f", attemptNumber: 1, fencingToken: 1, stage: "agent", status: "completed", at: "2026-10-28T10:06:00Z" });
    assert.equal((stale as any).error.details.reason, "stale_fencing_token");
    const run = await t.as("linus").query(api.runs.get, { runId });
    assert.equal(run.attemptNumber, 2);
    assert.equal(run.fencingToken, 2);
  } finally {
    await h.close();
  }
});
