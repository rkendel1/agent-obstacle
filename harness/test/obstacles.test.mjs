import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPaxShim, paxShimSummary, assessTransientRecovery, obstacleSchedule, workerFaultPlan } from '../obstacles/index.mjs';
import { run } from '../lib/proc.mjs';
import { COURSES_DIR } from '../lib/paths.mjs';
import { listCourses } from '../courses/index.mjs';

const tf = { id: 'transient-test-failure', type: 'transient-test-failure', params: { failFirst: 2, exitCode: 75 } };

test('the PAX shim fails the first N `pax test` calls transiently, then delegates to the real PAX; every call is logged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-shim-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proj = join(dir, 'proj');
  cpSync(join(COURSES_DIR, 'course-000-calibration/v1/fixture'), proj, { recursive: true });
  const shim = installPaxShim({ binDir: join(dir, 'bin'), logPath: join(dir, 'pax-calls.jsonl'), schedule: [tf] });
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, CARGO_TARGET_DIR: join(dir, 'target'), RUSTUP_TOOLCHAIN: 'stable' };
  const v = run(shim.bin, ['--version'], { env });
  assert.equal(v.stdout.trim(), 'pax 0.5.0', 'non-test operations pass through (Stack-Agent probes `pax --version`)');
  for (const n of [1, 2]) {
    const r = run('pax', ['--dir', proj, '--json', 'test'], { cwd: proj, env });
    assert.equal(r.code, 75, `call ${n} exits EX_TEMPFAIL`);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual([doc.schema, doc.operation, doc.status, doc.reason], ['pax.execution-result.v1', 'test', 'error', 'transient-infrastructure-failure']);
    assert.match(r.stderr, /TRANSIENT INFRASTRUCTURE FAILURE/);
  }
  const real = run('pax', ['--dir', proj, '--json', 'test'], { cwd: proj, env });
  assert.equal(real.code, 101, 'the third call runs the real (failing) tests');
  assert.equal(JSON.parse(real.stdout).status, 'failed');
  const s = paxShimSummary(shim.log);
  assert.deepEqual(s.tests.map((x) => [x.n, x.injected, x.status]), [[1, true, 'error'], [2, true, 'error'], [3, false, 'failed']]);
  assert.deepEqual(s.lastReal.tests, { passed: 1, failed: 1, ignored: 0, measured: 0 });
  const rec = assessTransientRecovery(tf, s);
  assert.deepEqual([rec.injected, rec.recognized, rec.recovered], [true, true, true]);
});

test('without an obstacle the shim only observes; recovery is null when the obstacle never triggered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-shim-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = installPaxShim({ binDir: join(dir, 'bin'), logPath: join(dir, 'log.jsonl'), schedule: [] });
  assert.equal(JSON.parse(readFileSync(join(dir, 'bin', '.pax-shim.json'), 'utf8')).testFailures, null);
  const rec = assessTransientRecovery(tf, paxShimSummary(shim.log));
  assert.deepEqual([rec.injected, rec.recognized, rec.recovered], [false, null, null]);
});

test('obstacle schedules come from the course: default, a named variant, or none', () => {
  const c1 = listCourses().find((c) => c.id === 'course-001-ddmrv');
  assert.deepEqual(obstacleSchedule(c1.doc, { enabled: true }).map((o) => o.type), ['transient-test-failure']);
  assert.deepEqual(obstacleSchedule(c1.doc, { enabled: true, overrides: { variant: 'interruption' } }).map((o) => o.type), ['transient-test-failure', 'process-interruption']);
  assert.deepEqual(obstacleSchedule(c1.doc, { enabled: false }), []);
  assert.throws(() => obstacleSchedule(c1.doc, { enabled: true, overrides: { variant: 'nope' } }), /no obstacle variant/);
  assert.deepEqual(workerFaultPlan({ AOC_FAULT_KILL: 'agent:1500' }), { stage: 'agent', when: 1500 });
  assert.deepEqual(workerFaultPlan({ AOC_FAULT_KILL: 'prepare' }), { stage: 'prepare', when: 'after' });
});
