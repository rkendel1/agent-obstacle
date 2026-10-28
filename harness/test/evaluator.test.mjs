import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolate, pendingRun } from './helpers.mjs';
import { loadCourseRef } from '../courses/index.mjs';
import { runDirect } from '../worker/direct.mjs';
import { ADAPTERS } from '../agents/index.mjs';
import { emptyMetrics } from '../agents/adapter.mjs';
import { classify, parseTestOutput, evaluatorVersion } from '../evaluator/index.mjs';
import { paxObserve, paxTest } from '../evidence/index.mjs';
import { run } from '../lib/proc.mjs';

const course = loadCourseRef('course-000-calibration/v1');
const direct = (runId, adapter, adapters = ADAPTERS, extra = {}) => runDirect({ runId, input: pendingRun({ runId, course, adapter, ...extra }), adapters });

/** A fake "agent" that claims success without fixing anything, or plants files, to test the evaluator. */
const fake = (id, act, claims) => ({ id, control: false, needsModel: false, version: () => 'fake-1', async run(req) {
  const t0 = Date.now(); await act?.(req);
  return { adapter: id, version: 'fake-1', control: false, claims, observed: { exitCode: 0, signal: null, durationMs: Date.now() - t0, timedOut: false }, metrics: emptyMetrics(), launches: [], observations: [], artifacts: [] };
} });

test('course-000: the unchanged base FAILS and the reference-control PASSES (evaluator calibration)', async (t) => {
  await isolate(t);
  const base = await direct('eval-base', 'null-control');
  assert.equal(base.result.outcome, 'FAIL');
  assert.equal(base.result.evaluation.acceptance, 'fail');
  assert.equal(base.result.evaluation.regression, 'fail');
  const ref = await direct('eval-ref', 'reference-control');
  assert.equal(ref.result.outcome, 'PASS');
  assert.equal(ref.result.evaluation.acceptance, 'pass');
  assert.equal(ref.result.evaluation.regression, 'pass');
  assert.match(ref.result.reproducibility.note, /CONTROL, not an agent/);
  assert.equal(ref.result.reproducibility.deterministic, true);
  assert.equal(ref.result.evaluation.evaluatorVersion, evaluatorVersion());
  assert.match(evaluatorVersion(), /^@aoc\/evaluator@1\.0\.0\+[0-9a-f]{12}$/);
  for (const k of ['courseDigest', 'fixtureDigest', 'finalTreeDigest', 'experimentDigest']) assert.match(ref.result.reproducibility[k], /^sha256:[0-9a-f]{64}$/);
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

test('constraint checks: planted evaluator path and a commit are critical violations; PASS is impossible with them', async (t) => {
  await isolate(t);
  const cheat = fake('cheat', async (req) => {
    run('git', ['apply', join(req.course.dir, 'evaluator/reference/fix.diff')], { cwd: req.workspace });   // (a cheat reading the evaluator dir)
    mkdirSync(join(req.workspace, 'tests'), { recursive: true });
    writeFileSync(join(req.workspace, 'tests/span_acceptance.rs'), '#[test] fn always() {}\n');
    run('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qam', 'fix'], { cwd: req.workspace });
  }, { agentTerminalState: 'completed', agentSaysVerified: true });
  const r = await direct('eval-cheat', 'cheat', { ...ADAPTERS, cheat });
  const ids = r.result.evaluation.violations.map((v) => v.id).sort();
  assert.deepEqual(ids, ['no-commits', 'no-evaluator-paths']);
  assert.ok(r.result.evaluation.violations.every((v) => v.severity === 'critical' && v.completed));
  assert.equal(r.result.outcome, 'FAIL');
  // the planted test was refused, the real hidden test was not overwritten
  assert.ok(r.result.evaluation.checks.some((c) => c.id === 'acceptance:tests/span_acceptance.rs' && c.result === 'error'));
});

test('ignored files and .stack-agent/ in the workspace cannot influence the evaluator; forbidden paths are flagged', async (t) => {
  await isolate(t);
  const sneaky = fake('sneaky', async (req) => {
    run('git', ['apply', join(req.course.dir, 'evaluator/reference/fix.diff')], { cwd: req.workspace });
    mkdirSync(join(req.workspace, '.stack-agent'), { recursive: true });
    writeFileSync(join(req.workspace, '.stack-agent/project.json'), '{}');
    mkdirSync(join(req.workspace, 'target'), { recursive: true });
    writeFileSync(join(req.workspace, 'target/poison'), 'x');                // ignored (/target)
    writeFileSync(join(req.workspace, 'Cargo.toml'), readFileSync(join(req.workspace, 'Cargo.toml'), 'utf8') + '\n# touched\n');
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
  assert.deepEqual(classify({ agent: { notRun: { failureClass: 'model' } } }), { outcome: 'BLOCKED', failureClass: 'model' });
  assert.equal(classify({ evaluation: { acceptance: 'pass', regression: 'pass', violations: [{ severity: 'critical', completed: true }] } }).outcome, 'FAIL');
});
