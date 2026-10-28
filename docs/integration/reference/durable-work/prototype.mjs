// End-to-end proof of the Durable Work run lifecycle for "aoc.attempt" against
// the published feltdb-server 0.3.0 + @feltdb/core 0.15.0. Run setup.mjs first.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createFeltDB, WorkloadClient } from '@feltdb/core';
import { ROOT, STATE, startServer } from './lib/server.mjs';
import { clientsFor, attemptRequest, fenceOf, errInfo, nowSeconds } from './lib/feltdb-work.mjs';

const cfg = JSON.parse(readFileSync(join(STATE, 'config.json'), 'utf8'));
const results = { checks: [], transitions: {}, notes: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = Date.now().toString(36);
const svcSubject = { kind: 'service', id: cfg.service.id };

let server = await startServer();
let app = clientsFor(server.url, cfg.service.secret, cfg.tenantId).workloads;   // the application backend
const asWorker = i => clientsFor(server.url, cfg.workers[i].key, cfg.tenantId).workloads;
const reconnect = () => { app = clientsFor(server.url, cfg.service.secret, cfg.tenantId).workloads; };

const req = (key, input) => attemptRequest({ tenantId: cfg.tenantId, appId: cfg.appId, requester: svcSubject, createGrant: cfg.grants.create, idempotencyKey: key, input });
const attemptInput = n => ({ attempt_no: n, agent: 'claude-agent-x', course: 'obstacle-course-v1', obstacles: ['maze', 'quiz', 'tool-use'], seed: 42 });
const transitions = w => w.execution_history.map(e => `${e.from ?? '∅'}->${e.to}${e.actor ? `(${e.actor.slice(0, 18)})` : ''}`);
const until = async (id, pred, ms = 20_000) => {
  const end = Date.now() + ms; let w;
  while (Date.now() < end) { w = await app.inspect(id); if (pred(w)) return w; await sleep(250); }
  throw new Error(`timeout waiting on ${id}: state=${w?.state}`);
};

/** Spawn worker.mjs as a real OS process; resolve events as they stream. */
function spawnWorker(id, idx, stageMs = 1500, onEvent = () => {}) {
  const child = spawn(process.execPath, [join(ROOT, 'worker.mjs'), id, String(idx), String(stageMs)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const events = []; let buf = '';
  child.stdout.on('data', d => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const ev = JSON.parse(line); events.push(ev); console.log('   [worker]', line); onEvent(ev, child); } catch { console.log('   [worker raw]', line); }
    }
  });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, events, exited };
}

// ---------------------------------------------------------------- 0. db.workloads stub
{
  const db = createFeltDB({ server: { url: server.url, token: cfg.service.secret, applicationId: cfg.appId, environment: 'local' }, authorityScope: { kind: 'tenant', tenantId: cfg.tenantId } });
  let stub;
  try { await db.workloads.inspect('workload_x'); stub = 'unexpectedly succeeded'; } catch (e) { stub = errInfo(e); }
  check('db.workloads is an unbound stub (baseUrl "", no credential) — not usable from Node', typeof stub === 'object', stub);
  const anon = await new WorkloadClient(server.url).list(cfg.appId).then(() => 'ok', errInfo);
  check('WorkloadClient without a credential-bearing fetcher is refused (401)', anon.status === 401, anon);
}

// ---------------------------------------------------------------- 1. admission + idempotency
const k1 = `aoc-attempt-${run}-1`;
const w1 = await app.create(req(k1, attemptInput(1)));
check('create -> READY', w1.state === 'READY', { id: w1.workload_id, state: w1.state, requested_by: w1.requested_by });
const w1b = await app.create(req(k1, attemptInput(1)));
check('same idempotency_key + same request -> same workload (replay)', w1b.workload_id === w1.workload_id, { first: w1.workload_id, second: w1b.workload_id });
const reordered = await app.create(req(k1, { seed: 42, obstacles: ['maze', 'quiz', 'tool-use'], course: 'obstacle-course-v1', agent: 'claude-agent-x', attempt_no: 1 }));
check('member order is not part of the canonical request', reordered.workload_id === w1.workload_id);
const conflict = await app.create(req(k1, attemptInput(999))).then(() => null, errInfo);
check('same key, different input -> 409 CONFLICT (IDEMPOTENCY_KEY_REUSED)', conflict?.status === 409, conflict);
const listed = (await app.list(cfg.appId)).workloads.filter(w => w.idempotency_key === k1);
check('list shows exactly one workload for the key', listed.length === 1, { count: listed.length });

// ---------------------------------------------------------------- 2. happy path in a worker process
{
  const wk = spawnWorker(w1.workload_id, 0, 1200);
  const exit = await wk.exited;
  const done = await app.inspect(w1.workload_id);
  check('happy path: worker exits 0 and workload SUCCEEDED', exit.code === 0 && done.state === 'SUCCEEDED', { exit, state: done.state });
  check('3 checkpoints, sequences 1..3', done.checkpoints.map(c => c.sequence).join() === '1,2,3', done.checkpoints.map(c => c.state));
  const result = await app.result(w1.workload_id);
  check('result() returns the output', result?.output?.total === 60, result);
  const history = await app.history(w1.workload_id);
  check('history() has events/attempts/checkpoints', Array.isArray(history.events) && history.attempts.length === 1, { events: history.events.length, attempts: history.attempts.map(a => a.status) });
  results.transitions.happy = transitions(done);
  const again = await asWorker(1).claim(w1.workload_id, { worker_id: cfg.workers[1].id, lease_ms: 5000, grant: cfg.workers[1].grant }).then(() => null, errInfo);
  check('a SUCCEEDED workload cannot be claimed again', again?.code === 'WORKLOAD_NOT_READY', again);
  const retried = await app.retry(w1.workload_id, cfg.grants.retry, 'again').then(() => null, errInfo);
  check('operator retry of SUCCEEDED -> 409 WORKLOAD_TRANSITION_DENIED', retried?.status === 409, retried);
  const workerRead = await asWorker(0).inspect(w1.workload_id).then(w => w.state, errInfo);
  results.notes.push({ worker_credential_can_inspect: workerRead });
}

// ---------------------------------------------------------------- 3. SIGKILL after checkpoint 2 -> reclaim -> fencing
const w2 = await app.create(req(`aoc-attempt-${run}-2`, attemptInput(2)));
let staleClaim;
{
  const killedAt = {};
  const wk = spawnWorker(w2.workload_id, 0, 1200, (ev, child) => {
    if (ev.event === 'claimed') staleClaim = ev;
    if (ev.event === 'checkpoint' && ev.sequence === 2) { killedAt.t = Date.now(); child.kill('SIGKILL'); }
  });
  const exit = await wk.exited;
  check('worker A killed with SIGKILL after checkpoint 2', exit.signal === 'SIGKILL', exit);
  const mid = await app.inspect(w2.workload_id);
  results.notes.push({ state_right_after_kill: mid.state, lease_expires_at: mid.current_claim?.expires_at, now: nowSeconds() });
  const recovered = await until(w2.workload_id, w => w.state === 'READY' && w.attempts.some(a => a.status === 'WORKER_LOST'));
  const ev = recovered.execution_history.find(e => e.to === 'RECOVERING');
  check('server recovers expired lease: RECOVERING -> READY, attempt WORKER_LOST', !!ev, { recovered_after_ms: Date.now() - killedAt.t, evidence: ev?.evidence });

  // Stale worker comes back before anyone reclaimed: no active claim.
  const staleFence = fenceOf(cfg.workers[0].id, { claim_id: staleClaim.claim_id, fencing_token: staleClaim.fencing_token }, cfg.workers[0].grant);
  const preReclaim = await asWorker(0).checkpoint(w2.workload_id, { ...staleFence, state: { stage: 'score', zombie: true } }).then(() => null, errInfo);
  check('stale checkpoint after recovery, before reclaim -> refused', preReclaim?.status >= 400, preReclaim);

  // Worker B reclaims; while it is running, the stale A tries to write.
  let staleDuring = {};
  const wkB = spawnWorker(w2.workload_id, 1, 2500, async ev => {
    if (ev.event === 'started') {
      staleDuring.checkpoint = await asWorker(0).checkpoint(w2.workload_id, { ...staleFence, state: { stage: 'score', zombie: true } }).then(() => 'ACCEPTED', errInfo);
      staleDuring.complete = await asWorker(0).complete(w2.workload_id, { ...staleFence, result_id: `zombie-${w2.workload_id}`, output: { zombie: true }, artifacts: [], schema_version: 1 }).then(() => 'ACCEPTED', errInfo);
      staleDuring.heartbeat = await asWorker(0).heartbeat(w2.workload_id, { ...staleFence, extend_ms: 5000 }).then(() => 'ACCEPTED', errInfo);
      // B's fence presented with A's credential (identity mismatch)
      const bClaim = wkB.events.find(e => e.event === 'claimed');
      staleDuring.forged = await asWorker(0).complete(w2.workload_id, { ...fenceOf(cfg.workers[1].id, bClaim, cfg.workers[1].grant), result_id: `forged-${w2.workload_id}`, output: {}, artifacts: [], schema_version: 1 }).then(() => 'ACCEPTED', errInfo);
    }
  });
  const exitB = await wkB.exited;
  const ctxEv = wkB.events.find(e => e.event === 'context');
  check('worker B reads prior checkpoints (stages 1-2 by worker A) via executionContext', ctxEv?.prior_checkpoints?.length === 2 && ctxEv.prior_checkpoints.every(c => c.by === cfg.workers[0].id), ctxEv?.prior_checkpoints);
  check('worker B skips completed stages and resumes at stage 3', wkB.events.filter(e => e.event === 'skip-stage').length === 2 && wkB.events.filter(e => e.event === 'checkpoint').length === 1);
  check('B fencing token > A fencing token', wkB.events.find(e => e.event === 'claimed').fencing_token > staleClaim.fencing_token, { a: staleClaim.fencing_token, b: wkB.events.find(e => e.event === 'claimed').fencing_token });
  check('stale A checkpoint with old fencing token -> 409 WORKLOAD_STALE_FENCE', staleDuring.checkpoint?.code === 'WORKLOAD_STALE_FENCE', staleDuring.checkpoint);
  check('stale A complete with old fencing token -> 409 WORKLOAD_STALE_FENCE', staleDuring.complete?.code === 'WORKLOAD_STALE_FENCE', staleDuring.complete);
  check('stale A heartbeat -> refused', staleDuring.heartbeat?.code === 'WORKLOAD_STALE_FENCE', staleDuring.heartbeat);
  check("A's credential with B's fence -> 403 identity mismatch", staleDuring.forged?.status === 403, staleDuring.forged);
  const done = await app.inspect(w2.workload_id);
  check('reclaimed workload SUCCEEDED, attempts [WORKER_LOST, SUCCEEDED], produced_by B', exitB.code === 0 && done.state === 'SUCCEEDED' && done.attempts.map(a => a.status).join() === 'WORKER_LOST,SUCCEEDED' && done.result.produced_by === cfg.workers[1].id, { state: done.state, attempts: done.attempts.map(a => [a.attempt_id, a.status, a.worker_id]), output: done.result?.output });
  check('checkpoints 1-2 from attempt 1, 3 from attempt 2', done.checkpoints.map(c => c.attempt_id.split('_').pop()).join() === '1,1,2', done.checkpoints.map(c => [c.sequence, c.state.stage, c.attempt_id]));
  results.transitions.killReclaim = transitions(done);
}

// ---------------------------------------------------------------- 4. cancellation
{
  const w3 = await app.create(req(`aoc-attempt-${run}-3`, attemptInput(3)));
  const c0 = await app.cancel(w3.workload_id, cfg.grants.cancel);
  check('cancel of READY (unclaimed) -> CANCELLED immediately', c0.state === 'CANCELLED', c0);
  const w4 = await app.create(req(`aoc-attempt-${run}-4`, attemptInput(4)));
  let cancelResp;
  const wk = spawnWorker(w4.workload_id, 0, 2500, async ev => {
    if (ev.event === 'started') cancelResp = await app.cancel(w4.workload_id, cfg.grants.cancel).catch(errInfo);
  });
  const exit = await wk.exited;
  const done = await app.inspect(w4.workload_id);
  check('cancel of RUNNING -> CANCELLATION_REQUESTED; worker confirms -> CANCELLED', cancelResp?.state === 'CANCELLATION_REQUESTED' && done.state === 'CANCELLED' && wk.events.some(e => e.event === 'cancel-confirmed'), { cancelResp, final: done.state, exit });
  const bad = await asWorker(0).cancel(w4.workload_id, cfg.workers[0].grant).then(() => null, errInfo);
  results.notes.push({ worker_cancel_with_worker_grant: bad });
  results.transitions.cancelRunning = transitions(done);
  results.transitions.cancelReady = transitions(await app.inspect(w3.workload_id));
}

// ---------------------------------------------------------------- 5. server restart (graceful) and crash (SIGKILL)
const digest = w => createHash('sha256').update(JSON.stringify({ s: w.state, h: w.execution_history, a: w.attempts, c: w.checkpoints, r: w.result })).digest('hex');
{
  const before = await Promise.all([w1, w2].map(w => app.inspect(w.workload_id)));
  await server.stop('SIGTERM');
  server = await startServer(); reconnect();
  const after = await Promise.all([w1, w2].map(w => app.inspect(w.workload_id)));
  check('graceful restart: state, history, attempts, checkpoints, result byte-identical', before.every((b, i) => digest(b) === digest(after[i])), after.map(w => w.state));
  const res = await app.result(w2.workload_id);
  check('result() after restart', res?.result_id === `result-${w2.workload_id}`, res?.output);
  const replay = await app.create(req(k1, attemptInput(1)));
  check('idempotent create after restart -> same workload', replay.workload_id === w1.workload_id);

  // Crash the server mid-attempt (and the worker with it).
  const w5 = await app.create(req(`aoc-attempt-${run}-5`, attemptInput(5)));
  let claimed;
  const wk = spawnWorker(w5.workload_id, 0, 1200, (ev, child) => {
    if (ev.event === 'claimed') claimed = ev;
    if (ev.event === 'checkpoint' && ev.sequence === 1) { child.kill('SIGKILL'); }
  });
  await wk.exited;
  await server.stop('SIGKILL');
  await sleep(6500); // stay down past the 5 s lease
  server = await startServer(); reconnect();
  const rec = await until(w5.workload_id, w => w.state === 'READY' && w.attempts.some(a => a.status === 'WORKER_LOST'));
  check('server SIGKILL mid-attempt: after restart, expired claim recovered to READY (WORKER_LOST)', true, { checkpoints: rec.checkpoints.length, history: transitions(rec) });
  const wkB = spawnWorker(w5.workload_id, 1, 800);
  const exitB = await wkB.exited;
  const done = await app.inspect(w5.workload_id);
  check('after crash+restart, worker B resumes from checkpoint 1 and completes', exitB.code === 0 && done.state === 'SUCCEEDED' && wkB.events.find(e => e.event === 'context')?.prior_checkpoints.length === 1, { state: done.state, attempts: done.attempts.map(a => a.status) });
  results.transitions.serverCrash = transitions(done);
}

await server.stop('SIGTERM');
results.summary = { passed: results.checks.filter(c => c.ok).length, failed: results.checks.filter(c => !c.ok).map(c => c.name) };
writeFileSync(join(STATE, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ transitions: results.transitions, notes: results.notes, summary: results.summary }, null, 2));
process.exit(results.summary.failed.length ? 1 : 0);
