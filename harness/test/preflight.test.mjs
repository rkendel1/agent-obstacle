// Preflight: the release gate. Baseline-must-fail and reference-must-pass are enforced; the report
// is bound to the course digest and carries no private material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { preflight, GATES } from '../preflight/index.mjs';
import { loadCourseRef, leakedFiles, courseDigest } from '../courses/index.mjs';
import { sha256 } from '../lib/util.mjs';
import { isolate, courseVariant, privateCourse } from './helpers.mjs';

const gate = (r, id) => r.gates.find((g) => g.id === id);

test('course-000 (declarative) passes every preflight gate; the report is bound to its digest and evaluator', async (t) => {
  const root = await isolate(t);
  const c = loadCourseRef('course-000-calibration/v2');
  const r = await preflight(c, { workRoot: join(root, 'pf') });
  assert.deepEqual(r.gates.map((g) => [g.id, g.result]), GATES.map((g) => [g, 'pass']));
  assert.equal(r.result, 'pass');
  assert.deepEqual(r.course, { id: c.id, version: c.version, digest: c.digest });
  assert.equal(r.evaluator.kind, 'declarative');
  assert.equal(r.acceptanceDigest, r.evaluator.digest);
  const b = gate(r, 'baseline-fails').evidence;
  assert.deepEqual([b.outcome, b.acceptance], ['FAIL', 'fail']);
  assert.deepEqual(b.checks.find((x) => x.id === 'inclusive-tests').counts, { passed: 1, failed: 2, skipped: 0 });
  const rf = gate(r, 'reference-passes').evidence;
  assert.deepEqual([rf.outcome, rf.acceptance], ['PASS', 'pass']);
  assert.ok(rf.checks.every((x) => x.result === 'pass' && x.executed));
  assert.equal(gate(r, 'tamper-detected').evidence.reason, 'course-digest-mismatch');
  assert.equal(gate(r, 'fixture-reproducible').evidence.first, gate(r, 'fixture-reproducible').evidence.second);
  assert.deepEqual(leakedFiles(c, JSON.stringify(r)), []);
  assert.deepEqual(readdirSync(join(root, 'pf')), [], 'preflight scratch removed');
});

test('a private evaluator passes preflight (tamper → evaluator-digest-mismatch), and its report leaks no hidden assertion', async (t) => {
  const root = await isolate(t);
  const c = privateCourse(join(root, 'courses'));
  const r = await preflight(c, { workRoot: join(root, 'pf') });
  assert.equal(r.result, 'pass', JSON.stringify(r.gates.filter((g) => g.result !== 'pass')));
  assert.equal(r.evaluator.digest, `sha256:${c.doc.evaluator.digest}`);
  assert.equal(gate(r, 'tamper-detected').evidence.reason, 'evaluator-digest-mismatch');
  assert.deepEqual(gate(r, 'reference-passes').evidence.checks.find((x) => x.id === 'acceptance:tests/span_acceptance.rs').counts, { passed: 3, failed: 0, skipped: 0 });
  const text = JSON.stringify(r);
  assert.deepEqual(leakedFiles(c, text), []);
  for (const name of ['inclusive_ranges_count_both_ends', 'totals_add_inclusive_lengths', 'span_len(i64::MAX']) assert.ok(!text.includes(name), name);
});

test('baseline-must-fail is enforced: a course whose declared baseline expectations do not hold FAILS preflight', async (t) => {
  const root = await isolate(t);
  // claims the documentation check fails on the unchanged fixture (it passes): the gate catches it
  const c = courseVariant(join(root, 'courses'), 'pf-baseline', (d) => { d.acceptance.preflight.baseline.mustFail = ['docs-unchanged']; });
  const r = await preflight(c, { workRoot: join(root, 'pf') });
  assert.equal(gate(r, 'baseline-fails').result, 'fail');
  assert.match(gate(r, 'baseline-fails').detail, /docs-unchanged must fail at the baseline \(got pass\)/);
  assert.equal(r.result, 'fail');
  // a course whose acceptance PASSES on the unchanged fixture cannot pass preflight at all
  const weak = courseVariant(join(root, 'courses'), 'pf-weak', (d) => {
    d.acceptance.require.of = d.acceptance.require.of.filter((x) => ['tests-unchanged', 'docs-unchanged'].includes(x.id));
    d.acceptance.preflight = { baseline: { mustFail: ['tests-unchanged'] } };
  });
  const w = await preflight(weak, { workRoot: join(root, 'pf') });
  assert.match(gate(w, 'baseline-fails').detail, /outcome PASS \(expected FAIL\)|acceptance pass \(expected fail\)/);
  assert.equal(w.result, 'fail');
});

test('reference-must-pass is enforced: a reference fix that does not satisfy acceptance FAILS preflight', async (t) => {
  const root = await isolate(t);
  const c = courseVariant(join(root, 'courses'), 'pf-reference', (d, dir) => {
    const diff = '--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,4 +1,5 @@\n //! Inclusive integer ranges.\n+//! (a reference that changes nothing that matters)\n //!\n //! `span_len(start, end)` returns how many integers lie in the inclusive range\n //! `start..=end`. An empty range (`end < start`) has length 0.\n';
    writeFileSync(join(dir, 'reference/fix.diff'), diff);
    d.evaluator.reference.digest = sha256(diff);
  });
  const r = await preflight(c, { workRoot: join(root, 'pf') });
  assert.equal(gate(r, 'baseline-fails').result, 'pass');
  assert.equal(gate(r, 'reference-passes').result, 'fail');
  assert.match(gate(r, 'reference-passes').detail, /outcome FAIL \(agent\) \(expected PASS\)/);
  assert.equal(r.result, 'fail');
});

test('a course with no usable evaluator stops at the first gate; nothing else reports pass', async (t) => {
  const root = await isolate(t);
  const c = courseVariant(join(root, 'courses'), 'pf-none', (d) => { d.evaluator = { kind: 'none' }; });
  const r = await preflight(c, { workRoot: join(root, 'pf') });
  assert.equal(gate(r, 'evaluator-resolved').result, 'fail');
  assert.ok(r.gates.filter((g) => g.id !== 'evaluator-resolved').every((g) => g.result === 'not-run'));
  assert.equal(r.result, 'fail');
  assert.equal(r.course.digest, courseDigest(c.doc));
});
