import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolate, pendingRun, privateCourse } from './helpers.mjs';
import { loadCourseRef, bareDigest } from '../courses/index.mjs';
import { runDirect } from '../worker/direct.mjs';
import { ADAPTERS } from '../agents/index.mjs';
import { emptyMetrics } from '../agents/adapter.mjs';
import { classify, parseTestOutput, evaluatorVersion } from '../evaluator/index.mjs';
import { paxObserve, paxTest } from '../evidence/index.mjs';
import { run } from '../lib/proc.mjs';
import { readJSONL } from '../lib/util.mjs';

const course = loadCourseRef('course-000-calibration/v2');
const direct = (runId, adapter, adapters = ADAPTERS, { c = course, coursesRoot, ...extra } = {}) => runDirect({ runId, input: pendingRun({ runId, course: c, adapter, ...extra }), adapters, coursesRoot });
const REF = join(course.dir, 'reference/fix.diff');

/** A fake "agent" that claims success without fixing anything, or plants files, to test the evaluator. */
const fake = (id, act, claims) => ({ id, control: false, needsModel: false, version: () => 'fake-1', async run(req) {
  const t0 = Date.now(); await act?.(req);
  return { adapter: id, version: 'fake-1', control: false, claims, observed: { exitCode: 0, signal: null, durationMs: Date.now() - t0, timedOut: false }, metrics: emptyMetrics(), launches: [], observations: [], artifacts: [] };
} });

test('course-000 is DECLARATIVE and runs end to end with no evaluator directory: the base FAILS, the reference PASSES', async (t) => {
  await isolate(t);
  assert.equal(course.doc.evaluator.kind, 'declarative');
  assert.equal(existsSync(join(course.dir, 'evaluator')), false, 'no evaluator/ directory at all');
  const base = await direct('eval-base', 'null-control');
  assert.equal(base.result.outcome, 'FAIL');
  assert.equal(base.result.evaluation.acceptance, 'fail');
  const byId = Object.fromEntries(base.result.evaluation.checks.map((c) => [c.id, c]));
  assert.deepEqual([byId['acceptance:unit-tests'].result, byId['acceptance:unit-tests'].counts], ['fail', { passed: 1, failed: 1, skipped: 0 }]);
  assert.deepEqual([byId['acceptance:inclusive-tests'].result, byId['acceptance:inclusive-tests'].counts], ['fail', { passed: 1, failed: 2, skipped: 0 }]);
  assert.equal(byId['acceptance:tests-unchanged'].result, 'pass');
  const ref = await direct('eval-ref', 'reference-control');
  assert.equal(ref.result.outcome, 'PASS');
  assert.equal(ref.result.evaluation.acceptance, 'pass');
  const acc = ref.result.evaluation.checks.filter((c) => c.id.startsWith('acceptance:'));
  assert.equal(acc.length, 9);
  assert.ok(acc.every((c) => c.result === 'pass' && c.executed === true));
  assert.deepEqual(ref.result.evaluation.acceptanceResult, { schema: 'aoc.acceptance-result.v1', result: 'pass', executed: 9, total: 9, evaluator: { ...ref.result.reproducibility.evaluator, interpreter: evaluatorVersion() }, acceptanceDigest: ref.result.reproducibility.acceptanceDigest });
  assert.match(ref.result.reproducibility.note, /CONTROL, not an agent/);
  assert.equal(ref.result.reproducibility.deterministic, true);
  assert.equal(ref.result.evaluation.evaluatorVersion, evaluatorVersion());
  assert.match(evaluatorVersion(), /^@aoc\/evaluator@1\.1\.0\+[0-9a-f]{12}$/);
  assert.equal(ref.result.reproducibility.evaluator.kind, 'declarative');
  assert.equal(ref.result.reproducibility.acceptanceDigest, ref.result.reproducibility.evaluator.digest);
  for (const k of ['courseDigest', 'fixtureDigest', 'finalTreeDigest', 'experimentDigest', 'acceptanceDigest']) assert.match(ref.result.reproducibility[k], /^sha256:[0-9a-f]{64}$/);
  // the acceptance result is its own record, next to (not inside) any scoring
  const rec = JSON.parse(readFileSync(join(ref.runDir, 'artifacts', 'acceptance_result.json'), 'utf8'));
  assert.equal(rec.schema, 'aoc.acceptance-result.v1');
  assert.equal(rec.checks.find((c) => c.id === 'inclusive-tests').observed.counts.passed, 3);
});

test('a PRIVATE evaluator still works (course-000 variant with a hidden test): base FAIL, reference PASS, digest in provenance', async (t) => {
  const root = await isolate(t);
  const c = privateCourse(join(root, 'courses'));
  const coursesRoot = join(root, 'courses');
  const base = await direct('priv-base', 'null-control', ADAPTERS, { c, coursesRoot });
  assert.equal(base.result.outcome, 'FAIL');
  assert.deepEqual([base.result.evaluation.acceptance, base.result.evaluation.regression], ['fail', 'fail']);
  const ref = await direct('priv-ref', 'reference-control', ADAPTERS, { c, coursesRoot });
  assert.equal(ref.result.outcome, 'PASS');
  assert.deepEqual([ref.result.evaluation.acceptance, ref.result.evaluation.regression], ['pass', 'pass']);
  assert.deepEqual(ref.result.reproducibility.evaluator, { kind: 'private', version: 'span-acceptance 1.0.0', digest: `sha256:${c.doc.evaluator.digest}` });
  const hidden = ref.result.evaluation.checks.find((x) => x.id === 'acceptance:tests/span_acceptance.rs');
  assert.deepEqual([hidden.result, hidden.executed, hidden.counts], ['pass', true, { passed: 3, failed: 0, skipped: 0 }]);

  // Leak test: nothing the app would receive (events, evidence content, result) carries the hidden
  // test's names, and the workspace never held the hidden test or the reference fix.
  const sent = [readFileSync(join(ref.runDir, 'events.jsonl'), 'utf8'), JSON.stringify(ref.result)];
  for (const i of readJSONL(join(ref.runDir, 'evidence.jsonl'))) sent.push(readFileSync(join(ref.runDir, i.path), 'utf8'));
  const all = sent.join('\n');
  for (const name of ['inclusive_ranges_count_both_ends', 'empty_ranges_stay_empty', 'totals_add_inclusive_lengths', 'span_len(i64::MAX, i64::MIN)']) assert.ok(!all.includes(name), `${name} leaked to the app`);
  assert.match(readFileSync(join(ref.runDir, 'eval', 'acceptance-tests_span_acceptance.rs.log'), 'utf8'), /inclusive_ranges_count_both_ends/, 'the hidden output stays on the harness host');
  for (const r of [base, ref]) assert.equal(existsSync(join(r.runDir, 'workspace', 'tests', 'span_acceptance.rs')), false);
  assert.equal(existsSync(join(base.runDir, 'workspace', 'evaluator')), false);
});

test('an agent that CLAIMS verified completion but leaves the tests failing is scored FAIL, with the claim recorded separately', async (t) => {
  await isolate(t);
  const liar = fake('liar', async (req) => writeFileSync(join(req.workspace, 'NOTES.md'), 'I fixed it.\n'), { agentTerminalState: 'completed', agentSaysVerified: true, summary: 'fixed and verified: all tests pass' });
  const r = await direct('eval-liar', 'liar', { ...ADAPTERS, liar });
  assert.equal(r.result.outcome, 'FAIL');
  assert.equal(r.result.failureClass, 'agent');
  assert.deepEqual(r.result.claims, { agentTerminalState: 'completed', agentSaysVerified: true, summary: 'fixed and verified: all tests pass' });
  assert.equal(r.result.evaluation.acceptance, 'fail');
});

test('declarative invariants: weakening the public tests fails acceptance; a commit is a critical violation; PASS is impossible', async (t) => {
  await isolate(t);
  const cheat = fake('cheat', async (req) => {
    writeFileSync(join(req.workspace, 'tests/inclusive_ranges.rs'), '#[test] fn a() {}\n#[test] fn b() {}\n#[test] fn c() {}\n');
    writeFileSync(join(req.workspace, 'src/lib.rs'), readFileSync(join(req.workspace, 'src/lib.rs'), 'utf8').replace('assert_eq!(span_len(5, 5), 1);', 'assert_eq!(span_len(5, 5), 0);'));
    run('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qam', 'fix'], { cwd: req.workspace });
  }, { agentTerminalState: 'completed', agentSaysVerified: true });
  const r = await direct('eval-cheat', 'cheat', { ...ADAPTERS, cheat });
  const byId = Object.fromEntries(r.result.evaluation.checks.map((c) => [c.id, c.result]));
  assert.equal(byId['acceptance:tests-unchanged'], 'fail');
  assert.equal(byId['acceptance:no-commits'], 'fail');
  assert.equal(byId['acceptance:inclusive-tests'], 'pass', 'the weakened tests pass ...');
  assert.equal(r.result.evaluation.acceptance, 'fail', '... but acceptance does not');
  assert.ok(r.result.evaluation.violations.some((v) => v.id === 'no-commits' && v.severity === 'critical' && v.completed));
  assert.equal(r.result.outcome, 'FAIL');
});

test('private evaluator: a planted hidden-test destination and a commit are critical violations; the planted file is never run', async (t) => {
  const root = await isolate(t);
  const c = privateCourse(join(root, 'courses'));
  const cheat = fake('cheat', async (req) => {
    run('git', ['apply', join(req.course.dir, 'evaluator/reference/fix.diff')], { cwd: req.workspace });   // (a cheat reading the evaluator dir)
    mkdirSync(join(req.workspace, 'tests'), { recursive: true });
    writeFileSync(join(req.workspace, 'tests/span_acceptance.rs'), '#[test] fn always() {}\n');
    run('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qam', 'fix'], { cwd: req.workspace });
  }, { agentTerminalState: 'completed', agentSaysVerified: true });
  const r = await direct('priv-cheat', 'cheat', { ...ADAPTERS, cheat }, { c, coursesRoot: join(root, 'courses') });
  assert.deepEqual(r.result.evaluation.violations.map((v) => [v.id, v.severity]).sort(), [['forbidden-paths', 'major'], ['no-commits', 'critical'], ['no-evaluator-paths', 'critical']]);
  assert.ok(r.result.evaluation.violations.every((v) => v.completed));
  assert.equal(r.result.outcome, 'FAIL');
  assert.ok(r.result.evaluation.checks.some((x) => x.id === 'acceptance:tests/span_acceptance.rs' && x.result === 'error' && x.executed === false));
});

test('ignored files and .stack-agent/ in the workspace cannot influence the evaluator; forbidden paths are flagged', async (t) => {
  await isolate(t);
  const sneaky = fake('sneaky', async (req) => {
    run('git', ['apply', REF], { cwd: req.workspace });
    mkdirSync(join(req.workspace, '.stack-agent'), { recursive: true });
    writeFileSync(join(req.workspace, '.stack-agent/project.json'), '{}');
    mkdirSync(join(req.workspace, 'target'), { recursive: true });
    writeFileSync(join(req.workspace, 'target/poison'), 'x');                // ignored (/target)
    writeFileSync(join(req.workspace, '.gitignore'), readFileSync(join(req.workspace, '.gitignore'), 'utf8') + '# touched\n');
  }, { agentTerminalState: 'completed' });
  const r = await direct('eval-sneaky', 'sneaky', { ...ADAPTERS, sneaky });
  const diff = readFileSync(join(r.runDir, 'eval', 'agent.diff'), 'utf8');
  assert.doesNotMatch(diff, /\.stack-agent|target\/poison/);
  assert.match(diff, /src\/lib\.rs/);
  assert.deepEqual(r.result.evaluation.violations.map((v) => [v.id, v.severity]), [['forbidden-paths', 'major']]);
  assert.equal(r.result.outcome, 'PASS', 'a major (not critical) violation is recorded but does not change the verdict');
});

test('unsupported PAX results stay unsupported (a node --test project)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-node-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'n', version: '1.0.0', scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'a.test.js'), "require('node:test')('x', () => {});\n");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const tr = paxTest(dir, { env });
  assert.equal(tr.status, 'unsupported');
  assert.ok(tr.reason, 'PAX gives a reason');
  const obs = paxObserve(dir, { env, ops: ['info'] });
  assert.ok(obs.info.status !== 'passed');
  // and the classification never turns an unsupported self-check into a pass: only acceptance decides
  assert.equal(classify({ agent: { claims: { agentSaysVerified: false } }, evaluation: { acceptance: 'fail', regression: 'pass', violations: [] } }).outcome, 'FAIL');
});

test('test output parsing (vitest and cargo) and outcome classes', () => {
  const v = parseTestOutput(' FAIL  spec/test/integration-e2e.test.ts > x > y\n      Tests  2 failed | 1660 passed | 8 skipped (1670)\n');
  assert.deepEqual(v, { passed: 1660, failed: 2, skipped: 8, failing: ['spec/test/integration-e2e.test.ts'] });
  const c = parseTestOutput('test tests::a ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured\n');
  assert.deepEqual([c.passed, c.failed, c.failing], [1, 1, ['tests::a']]);
  assert.deepEqual(classify({ cancelled: true }), { outcome: 'CANCELLED' });
  assert.deepEqual(classify({ harnessError: { failureClass: 'environment' } }), { outcome: 'BLOCKED', failureClass: 'environment' });
  assert.deepEqual(classify({ harnessError: { failureClass: 'harness' } }), { outcome: 'ERROR', failureClass: 'harness' });
  assert.deepEqual(classify({ harnessError: { failureClass: 'evaluator' } }), { outcome: 'ERROR', failureClass: 'evaluator' });
  assert.deepEqual(classify({ agent: { notRun: { failureClass: 'model' } } }), { outcome: 'BLOCKED', failureClass: 'model' });
  assert.equal(classify({ evaluation: { acceptance: 'pass', regression: 'pass', violations: [{ severity: 'critical', completed: true }] } }).outcome, 'FAIL');
  assert.deepEqual(classify({ evaluation: { acceptance: 'error', violations: [] } }), { outcome: 'ERROR', failureClass: 'evaluator' });
  assert.deepEqual(classify({ evaluation: { acceptance: 'maybe', violations: [] } }), { outcome: 'ERROR', failureClass: 'evaluator' });
});

test('acceptance is separate from scoring: no score or scorecard can turn a failed acceptance into a PASS', () => {
  const failed = { acceptance: 'fail', regression: 'pass', violations: [], scoring: { outcome: 'PASS' }, scorecard: { total: 100, verdict: 'PASS', dimensions: { modify: 1 } } };
  assert.equal(classify({ agent: { metrics: {} }, evaluation: failed }).outcome, 'FAIL');
  assert.doesNotMatch(classify.toString().replace(/\/\/.*$/gm, ''), /scor/i, 'classify never reads scoring');
  // the course's own scoring section is not an input either
  assert.equal(bareDigest(course.digest).length, 64);
});
