import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { digestOf } from "../feltkit/lib/canonical.js";
import { definition, preflightFor, resultFor, sampleAcceptance, sampleCourse, seed } from "./support.js";

const harness = { id: "harness-key", type: "service" as const, roles: ["harness"] };
const AUTHORITY = { url: "http://127.0.0.1:7791", namespace: "aoc", release: "feltdb-server 0.3.0" };
const reason = (r: string) => (e: any) => e.code === "INVALID_ARGUMENT" && e.details?.reason === r;
const problem = (re: RegExp) => (e: any) => e.details?.reason === "invalid_course" && e.details.problems.some((p: string) => re.test(p));

test("publish is gated by a passing preflight for the exact document (required, failing, mismatched)", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const course = sampleCourse({ version: "3.0.0" });
    await assert.rejects(ada.mutation(api.courses.publish, { course }), reason("preflight_required"));
    // a failing report is recorded (auditable) but never gates a publish
    const failing = preflightFor(course, { result: "fail", gates: preflightFor(course).gates.map((g: any) => (g.id === "baseline-fails" ? { ...g, result: "fail" } : g)) });
    const rec = await ada.mutation(api.courses.recordPreflight, { report: failing });
    assert.equal(rec.passing, false);
    await assert.rejects(ada.mutation(api.courses.publish, { course }), (e: any) => reason("preflight_failed")(e) && /baseline-fails/.test(e.message));
    // "pass" with a gate missing is not passing
    const partial = preflightFor(course, { gates: preflightFor(course).gates.filter((g: any) => g.id !== "tamper-detected") });
    assert.equal((await ada.mutation(api.courses.recordPreflight, { report: partial })).passing, false);
    // a report for another document (other digest) does not count
    await assert.rejects(ada.mutation(api.courses.publish, { course, preflight: preflightFor(sampleCourse({ version: "3.0.0", acceptanceSummary: "other" })) }), (e: any) => reason("preflight_failed")(e) && /tamper-detected missing/.test(e.message));
    // a report bound to this digest but naming another acceptance / evaluator is refused
    await assert.rejects(ada.mutation(api.courses.publish, { course, preflight: preflightFor(course, { acceptanceDigest: digestOf({ other: true }) }) }), reason("preflight_mismatch"));
    // malformed reports are refused outright
    await assert.rejects(ada.mutation(api.courses.recordPreflight, { report: { schema: "nope" } }), reason("invalid_preflight"));
    // developers cannot record a preflight
    await assert.rejects(t.as("grace").mutation(api.courses.recordPreflight, { report: preflightFor(course) }), { code: "FORBIDDEN" });

    const ok = await ada.mutation(api.courses.publish, { course, preflight: preflightFor(course) });
    assert.equal(ok.created, true);
    const v = await ada.query(api.courses.get, { courseVersionId: ok.courseVersionId });
    assert.equal(v.preflight!.passing, true);
    assert.equal(v.preflightReportDigest, digestOf(preflightFor(course)));
    assert.equal(v.acceptanceDigest, digestOf(course.acceptance));
    assert.equal(v.evaluatorKind, "declarative");
    // failing + partial + the passing one (a refused publish records nothing: the mutation is atomic)
    assert.equal((await t.as("linus").query(api.courses.preflights, { courseDigest: ok.digest })).length, 3);
  } finally {
    await t.close();
  }
});

test("acceptance.v1 is validated at publish: unknown kinds or fields, unapproved programs, unsafe paths and implicit composition are refused", async () => {
  const t = await createTestApp();
  try {
    const grace = t.as("grace");
    const withAcc = (mut: (a: any) => void) => {
      const a = sampleAcceptance();
      mut(a);
      return sampleCourse({ version: "0.9.0", acceptance: a });
    };
    const draft = (spec: unknown) => grace.mutation(api.courses.createDraft, { spec });
    await assert.rejects(draft(withAcc((a) => a.require.of.push({ id: "magic", kind: "llm-judge", prompt: "is it good?" }))), problem(/unknown check kind "llm-judge"/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[1].retries = 3))), problem(/unknown field "retries"/));
    await assert.rejects(draft(withAcc((a) => (a.extra = true))), problem(/acceptance: unknown field "extra"/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[1].argv = ["sh", "-c", "cargo test"]))), problem(/"sh" is not an approved program/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[1].argv = ["node", "-e", "process.exit(0)"]))), problem(/is not listed in acceptance.toolchain|"node -e" is refused/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[1].argv = ["cargo", "install", "x"]))), problem(/approved subcommands/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[0].paths = ["../outside"]))), problem(/must not contain empty, "." or ".." segments/));
    await assert.rejects(draft(withAcc((a) => (a.require.of[0].paths = ["/etc/passwd"]))), problem(/relative to the evaluation tree/));
    await assert.rejects(draft(withAcc((a) => delete a.require.of[1].timeoutSecs)), problem(/timeoutSecs must be an integer/));
    await assert.rejects(draft(withAcc((a) => delete a.require.of[1].exit)), problem(/exit is required/));
    await assert.rejects(draft(withAcc((a) => (a.require = a.require.of[1]))), problem(/explicit "all" or "any"/));
    await assert.rejects(draft(withAcc((a) => (a.preflight.baseline.mustFail = []))), problem(/mustFail must name at least one/));
    await assert.rejects(draft(withAcc((a) => (a.require.of.push({ id: "re", kind: "file-content", path: "src/lib.rs", match: { regex: "(a+)+$" } })))), problem(/nested quantifiers/));
    let deep: any = { id: "leaf", kind: "files-exist", paths: ["a"] };
    for (let i = 0; i < 5; i++) deep = { id: `n${i}`, kind: "all", of: [deep] };
    await assert.rejects(draft(withAcc((a) => (a.require.of = [deep]))), problem(/nesting deeper than 4/));
    // no evaluator declaration, an unknown kind, a private evaluator without a pinned digest
    const { evaluator: _e, ...noEvaluator } = sampleCourse({ version: "0.9.1" });
    await assert.rejects(draft(noEvaluator), problem(/missing section "evaluator"/));
    await assert.rejects(draft(sampleCourse({ version: "0.9.2", evaluator: { kind: "magic" } })), problem(/evaluator.kind must be one of/));
    await assert.rejects(draft(sampleCourse({ version: "0.9.3", evaluator: { kind: "private", dir: "evaluator", version: "1" } })), problem(/evaluator.digest must pin/));
    // the shipped course documents are valid for the app as they are
    for (const f of ["courses/course-000-calibration/v2/course.json", "courses/course-001-ddmrv/v2/course.json"]) {
      const doc = JSON.parse(readFileSync(f, "utf8"));
      const d = await grace.mutation(api.courses.createDraft, { spec: doc });
      await grace.mutation(api.courses.discardDraft, { courseVersionId: d.courseVersionId });
    }
  } finally {
    await t.close();
  }
});

test("published acceptance and its preflight are frozen; evaluator provenance in a result is checked against the version", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const course = sampleCourse();
    const { courseVersionId, experimentId } = await seed(t, course);
    const before = await ada.query(api.courses.get, { courseVersionId });
    // no further preflight can be recorded for a published digest
    await assert.rejects(ada.mutation(api.courses.recordPreflight, { report: preflightFor(course, { completedAt: "2026-10-28T10:00:00.000Z" }) }), reason("immutable_version"));
    // the identical report is an idempotent replay
    assert.equal((await ada.mutation(api.courses.recordPreflight, { report: preflightFor(course) })).created, false);
    await t.restart();
    const after = await ada.query(api.courses.get, { courseVersionId });
    assert.equal(after.acceptanceDigest, before.acceptanceDigest);
    assert.equal(after.acceptanceDigest, digestOf(course.acceptance));
    assert.equal(after.preflightReportDigest, before.preflightReportDigest);
    assert.deepEqual(after.spec, course);

    const grace = t.as("grace");
    const h = t.as(harness);
    const launch = async (wl: string) => {
      const { runId } = await grace.mutation(api.runs.launch, { experimentId, courseVersionId });
      await h.mutation(api.harness.admitted, { runId, workloadId: wl, workAuthority: AUTHORITY });
      const run = await ada.query(api.runs.get, { runId });
      return { runId, workloadId: wl, courseDigest: run.courseDigest, experimentDigest: run.experimentDigest };
    };
    const r1 = await launch("wl_p1");
    const base = resultFor(r1) as any;
    const tampered = { ...base, reproducibility: { ...base.reproducibility, acceptanceDigest: digestOf({ easier: true }) } };
    await assert.rejects(h.mutation(api.harness.completed, tampered), (e: any) => reason("evaluator_mismatch")(e) && /frozen acceptance/.test(e.message));
    const wrongKind = { ...base, reproducibility: { ...base.reproducibility, evaluator: { kind: "private", version: "x", digest: `sha256:${"1".repeat(64)}` } } };
    await assert.rejects(h.mutation(api.harness.completed, wrongKind), reason("evaluator_mismatch"));
    const { evaluator: _ev, acceptanceDigest: _ad, ...noProvenance } = base.reproducibility;
    await assert.rejects(h.mutation(api.harness.completed, { ...base, reproducibility: noProvenance }), (e: any) => reason("evaluator_mismatch")(e) && /needs reproducibility.evaluator/.test(e.message));
    await h.mutation(api.harness.completed, base);
    const done = await ada.query(api.runs.get, { runId: r1.runId });
    assert.equal(done.outcome, "PASS");
    assert.equal((done.result as any).reproducibility.acceptanceDigest, after.acceptanceDigest);
    // an ERROR before any evaluation needs no provenance
    const r2 = await launch("wl_p2");
    await h.mutation(api.harness.completed, resultFor(r2, { outcome: "ERROR", failureClass: "evaluator", evaluation: { evaluatorVersion: "aoc-evaluator 1.0.0", acceptance: "error", checks: [], violations: [] }, reproducibility: { ...noProvenance, courseDigest: r2.courseDigest, experimentDigest: r2.experimentDigest } }) as any);
    assert.equal(definition.agent.adapter, "stack-agent");
  } finally {
    await t.close();
  }
});

test("a private evaluator's pinned digest is what a result must report", async () => {
  const t = await createTestApp();
  try {
    const pinned = "ab".repeat(32);
    const acc = {
      schema: "aoc.private-acceptance.v1",
      summary: "hidden acceptance",
      toolchain: ["cargo"],
      regression: { command: ["cargo", "test", "--lib"] },
      hidden: [{ file: "evaluator/acceptance/a.rs", dest: "tests/a.rs", command: ["cargo", "test", "--test", "a"] }],
      preflight: { baseline: { mustFail: ["acceptance:tests/a.rs"], mustPass: ["regression"] } },
    };
    const course = sampleCourse({ version: "5.0.0", evaluator: { kind: "private", dir: "evaluator", version: "1.0.0", digest: pinned }, acceptance: acc });
    // the report must carry the pinned private digest
    await assert.rejects(t.as("ada").mutation(api.courses.publish, { course, preflight: preflightFor(course, { evaluator: { kind: "private", version: "1.0.0", digest: `sha256:${"cd".repeat(32)}` } }) }), reason("preflight_mismatch"));
    const { courseVersionId, experimentId } = await seed(t, course);
    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });
    const h = t.as(harness);
    await h.mutation(api.harness.admitted, { runId, workloadId: "wl_priv", workAuthority: AUTHORITY });
    const run = await t.as("ada").query(api.runs.get, { runId });
    const ids = { runId, workloadId: "wl_priv", courseDigest: run.courseDigest, experimentDigest: run.experimentDigest };
    const prov = (digest: string) => ({ evaluator: { kind: "private", version: "1.0.0", digest: `sha256:${digest}` }, acceptanceDigest: digestOf(acc) });
    const base = resultFor(ids, { outcome: "FAIL", failureClass: "agent", evaluation: { evaluatorVersion: "aoc-evaluator 1.0.0", acceptance: "fail", checks: [], violations: [] } }) as any;
    await assert.rejects(h.mutation(api.harness.completed, { ...base, reproducibility: { ...base.reproducibility, ...prov("cd".repeat(32)) } }), (e: any) => reason("evaluator_mismatch")(e) && /private evaluator digest/.test(e.message));
    await h.mutation(api.harness.completed, { ...base, reproducibility: { ...base.reproducibility, ...prov(pinned) } });
    assert.equal((await t.as("ada").query(api.runs.get, { runId })).outcome, "FAIL");
  } finally {
    await t.close();
  }
});
