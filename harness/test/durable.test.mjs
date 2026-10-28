// Durable Work lifecycle against a real feltdb-server 0.3.0 (one per test file, own state dir and port).
// The app side is the in-memory FakeApp (unit tests of harness logic only), served over the AppPort
// HTTP envelope where a separate harness process needs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isolate, startAuthorityForTest, pendingRun, serveFakeApp } from './helpers.mjs';
import { FakeApp } from '../app-client/fake-app.mjs';
import { AppClient } from '../app-client/index.mjs';
import { AppSink } from '../worker/recorder.mjs';
import { Dispatcher } from '../dispatcher/index.mjs';
import { loadCourseRef } from '../courses/index.mjs';
import { authorityClients, fenceOf, errInfo } from '../work-authority/client.mjs';
import { ADAPTERS } from '../agents/index.mjs';
import { emptyMetrics } from '../agents/adapter.mjs';
import { spawnGroup, groupAlive, terminateGroup } from '../lib/proc.mjs';
import { sleep, readJSONL } from '../lib/util.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const course = loadCourseRef('course-000-calibration/v1');
const quiet = () => {};
let A;   // authority (shared by the tests in this file)
let ROOT;

test('setup: isolated authority', async (t) => {
  ROOT = await isolate(null);
  A = await startAuthorityForTest(null);
  assert.ok(A.state.complete);
  const again = await A.setupAuthority({});
  assert.equal(again.tenantId, A.state.tenantId, 'setup is idempotent');
  const mode = (await import('node:fs')).statSync(join(process.env.AOC_HARNESS_STATE_DIR, 'secrets.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('happy path over the AppPort wire: admit (idempotency = runId), claim, 6 checkpointed stages, complete, runs.completed PASS', async (t) => {
  const fake = new FakeApp();
  const srv = await serveFakeApp(fake, t);
  const app = new AppClient({ url: srv.url, apiKey: srv.apiKey });
  fake.request(pendingRun({ runId: 'd-happy', course, adapter: 'reference-control' }));
  const d = new Dispatcher({ app, sink: new AppSink(app), state: A.loadState(), log: quiet, leaseMs: 6000 });
  await d.once({ maxMs: 120_000 });
  const run = fake.run('d-happy');
  assert.equal(run.result?.outcome, 'PASS');
  assert.ok(run.workloadId);
  const { app: W } = authorityClients(A.loadState());
  const w = await W.inspect(run.workloadId);
  assert.equal(w.state, 'SUCCEEDED');
  assert.equal(w.idempotency_key, 'd-happy');
  assert.deepEqual(w.checkpoints.map((c) => c.state.stage), ['prepare', 'observe-before', 'agent', 'observe-after', 'evaluate', 'report']);
  assert.deepEqual([...new Set(run.stages.map((s) => s.stage))], ['prepare', 'observe-before', 'agent', 'observe-after', 'evaluate', 'report']);
  assert.ok(run.stages.every((s) => s.fencingToken === w.attempts[0].fencing_token || s.fencingToken >= 1));
  assert.ok(run.events.size > 20 && run.evidence.has('acceptance:verdict') && run.evidence.has('diff:agent'));
  // a second tick admits nothing new
  await d.tick();
  assert.equal((await W.list(A.loadState().appId)).workloads.filter((x) => x.idempotency_key === 'd-happy').length, 1);
});

test('worker SIGKILLed mid-stage: lease expires, another worker reclaims with a higher fence and resumes from the last checkpoint', async (t) => {
  const fake = new FakeApp();
  const srv = await serveFakeApp(fake, t);
  fake.request(pendingRun({ runId: 'd-kill', course, adapter: 'reference-control', options: { holdMs: 5000 } }));
  const env = { ...process.env, AOC_APP_URL: srv.url, AOC_HARNESS_API_KEY: srv.apiKey, AOC_LEASE_MS: '4000', AOC_POLL_MS: '500' };
  const runChild = (extra) => new Promise((resolve) => {
    const c = spawn(process.execPath, [join(REPO_ROOT, 'harness/cli.mjs'), 'once'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
  const first = await runChild({ AOC_WORKER: 'aoc-worker-a', AOC_FAULT_KILL: 'agent:1500' });
  assert.equal(first.signal, 'SIGKILL', first.out.slice(-2000));
  const { app: W } = authorityClients(A.loadState());
  const wid = fake.run('d-kill').workloadId;
  const mid = await W.inspect(wid);
  assert.ok(['RUNNING', 'CHECKPOINTED', 'READY', 'RECOVERING'].includes(mid.state), mid.state);
  const second = await runChild({ AOC_WORKER: 'aoc-worker-b' });
  assert.equal(second.code, 0, second.out.slice(-2000));
  const w = await W.inspect(wid);
  assert.equal(w.state, 'SUCCEEDED');
  assert.deepEqual(w.attempts.map((a) => a.status), ['WORKER_LOST', 'SUCCEEDED']);
  const claims = readJSONL(join(process.env.AOC_RUNS_DIR, 'd-kill', 'claims.jsonl'));
  assert.equal(claims.length, 2);
  assert.ok(claims[1].fencing_token > claims[0].fencing_token, 'higher fence on reclaim');
  assert.notEqual(claims[0].worker, claims[1].worker);
  const events = readJSONL(join(process.env.AOC_RUNS_DIR, 'd-kill', 'events.jsonl'));
  assert.ok(events.some((e) => /stage prepare already checkpointed/.test(e.summary)));
  assert.ok(events.some((e) => /stage observe-before already checkpointed/.test(e.summary)));
  assert.equal(w.checkpoints.filter((c) => c.state.stage === 'prepare').length, 1, 'prepare was not re-executed');
  const result = fake.run('d-kill').result;
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.metrics.attempts, 2);
  assert.ok(result.recovery.some((r) => r.obstacleId === 'harness-worker-interruption' && r.injected && r.recovered));
});

test('a stale fence is refused by the authority', async () => {
  const st = A.loadState();
  const { app: W } = authorityClients(st);
  const a = authorityClients(st, 'aoc-worker-a'); const b = authorityClients(st, 'aoc-worker-b');
  const { attemptRequest } = await import('../work-authority/client.mjs');
  const wl = await W.create(attemptRequest({ state: st, runId: 'd-stale', input: { runId: 'd-stale' }, overallMs: 600_000 }));
  const { meshHeartbeat } = await import('../work-authority/client.mjs');
  await meshHeartbeat(a.workerMesh, a.worker, 0); await meshHeartbeat(b.workerMesh, b.worker, 0);
  const ca = await a.workerWorkloads.claim(wl.workload_id, { worker_id: a.worker.id, lease_ms: 2000, grant: a.worker.grant });
  const fa = fenceOf(a.worker, ca);
  await a.workerWorkloads.start(wl.workload_id, fa);
  for (let i = 0; i < 40 && (await W.inspect(wl.workload_id)).state !== 'READY'; i++) await sleep(250);
  const cb = await b.workerWorkloads.claim(wl.workload_id, { worker_id: b.worker.id, lease_ms: 10_000, grant: b.worker.grant });
  assert.ok(cb.fencing_token > ca.fencing_token);
  const stale = await a.workerWorkloads.checkpoint(wl.workload_id, { ...fa, state: { stage: 'zombie' } }).then(() => 'ACCEPTED', errInfo);
  assert.equal(stale.code, 'WORKLOAD_STALE_FENCE');
  const fb = fenceOf(b.worker, cb);
  await b.workerWorkloads.start(wl.workload_id, fb);
  await b.workerWorkloads.complete(wl.workload_id, { ...fb, result_id: `result-${wl.workload_id}`, output: {}, artifacts: [], schema_version: 1 });
  assert.equal((await W.inspect(wl.workload_id)).checkpoints.length, 0, 'nothing from the stale worker landed');
});

test('authority restart (SIGKILL) mid-run: the worker retries transport failures and the run completes in the same attempt', async (t) => {
  const fake = new FakeApp();
  fake.request(pendingRun({ runId: 'd-restart', course, adapter: 'null-control', options: { holdMs: 6000 } }));
  const d = new Dispatcher({ app: fake, sink: new AppSink(fake), state: A.loadState(), log: quiet, leaseMs: 20_000 });
  const done = d.once({ maxMs: 180_000, pollMs: 300 });
  for (let i = 0; i < 100 && !fake.run('d-restart').stages.some((s) => s.stage === 'agent'); i++) await sleep(100);
  await A.stopAuthority({ signal: 'SIGKILL' });
  await sleep(2000);
  await A.startAuthority();
  await done;
  const r = fake.run('d-restart');
  assert.equal(r.result?.outcome, 'FAIL', 'null-control fails acceptance, as calibrated');
  const w = await authorityClients(A.loadState()).app.inspect(r.workloadId);
  assert.equal(w.state, 'SUCCEEDED');
  assert.equal(w.attempts.length, 1);
});

test('cancellation: the agent process group is killed, cancellation confirmed, outcome CANCELLED', async (t) => {
  let pgid = null;
  const sleeper = { id: 'sleeper', control: false, needsModel: false, version: () => 'sleeper-1', async run(req) {
    const t0 = Date.now();
    const p = spawnGroup('sh', ['-c', 'sleep 300 & sleep 300 & wait'], { cwd: req.workspace, env: req.env });
    pgid = p.pgid;
    await new Promise((resolve) => { req.signal.addEventListener('abort', resolve, { once: true }); p.exited.then(resolve); });
    await terminateGroup(p.pgid, { graceMs: 1000 });
    return { adapter: 'sleeper', version: 'sleeper-1', control: false, claims: { agentTerminalState: 'cancelled' }, observed: { exitCode: null, signal: 'SIGTERM', durationMs: Date.now() - t0, timedOut: false, cancelled: true }, metrics: emptyMetrics(), launches: [], observations: [], artifacts: [] };
  } };
  const fake = new FakeApp();
  fake.request(pendingRun({ runId: 'd-cancel', course, adapter: 'sleeper' }));
  const d = new Dispatcher({ app: fake, sink: new AppSink(fake), state: A.loadState(), log: quiet, adapters: { ...ADAPTERS, sleeper }, leaseMs: 6000 });
  const done = d.once({ maxMs: 120_000, pollMs: 300 });
  for (let i = 0; i < 200 && !pgid; i++) await sleep(100);
  assert.ok(pgid && groupAlive(pgid), 'agent group running');
  fake.requestCancel('d-cancel');
  await done;
  assert.equal(groupAlive(pgid), false, 'process group gone');
  const r = fake.run('d-cancel');
  assert.equal(r.result?.outcome, 'CANCELLED');
  assert.equal(r.result.evaluation.acceptance, 'not-run');
  const w = await authorityClients(A.loadState()).app.inspect(r.workloadId);
  assert.equal(w.state, 'CANCELLED');
});

test('teardown', async () => { await A.stopAuthority(); if (!process.env.AOC_KEEP_TEST_DIRS) (await import('node:fs')).rmSync(ROOT, { recursive: true, force: true }); });
