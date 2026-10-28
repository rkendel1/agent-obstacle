// A worker process for one aoc.attempt workload. Emits one JSON line per event.
//   node worker.mjs <workloadId> <workerIndex 0|1> [stageMs=1500] [leaseMs=5000]
// Resumes from the last committed checkpoint (read via executionContext), so the
// same program serves both a first attempt and a reclaim after a crash.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from './lib/server.mjs';
import { clientsFor, fenceOf, meshHeartbeat, errInfo } from './lib/feltdb-work.mjs';

const [workloadId, idx = '0', stageMsArg = '1500', leaseMsArg = '5000'] = process.argv.slice(2);
const stageMs = Number(stageMsArg), leaseMs = Number(leaseMsArg);
const cfg = JSON.parse(readFileSync(join(STATE, 'config.json'), 'utf8'));
const me = cfg.workers[Number(idx)];
const { workloads, workers } = clientsFor(cfg.url, me.key, cfg.tenantId);
const emit = (event, extra = {}) => console.log(JSON.stringify({ t: Date.now(), pid: process.pid, worker: me.name, event, ...extra }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STAGES = ['setup', 'run-obstacles', 'score'];

try {
  await meshHeartbeat(workers, me);                       // be READY on the mesh
  const claim = await workloads.claim(workloadId, { worker_id: me.id, lease_ms: leaseMs, grant: me.grant });
  emit('claimed', { claim_id: claim.claim_id, fencing_token: claim.fencing_token, expires_at: claim.expires_at });
  const fence = fenceOf(me.id, claim, me.grant);

  const ctx = await workloads.executionContext(workloadId, fence);
  const done = ctx.checkpoints.map(c => c.state.stage);
  emit('context', { attempt_id: ctx.attempt_id, input: ctx.input, prior_checkpoints: ctx.checkpoints.map(c => ({ seq: c.sequence, stage: c.state.stage, by: c.produced_by, attempt: c.attempt_id })) });

  await workloads.start(workloadId, fence);
  emit('started');

  const scores = Object.fromEntries(ctx.checkpoints.map(c => [c.state.stage, c.state.score]));
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    if (done.includes(stage)) { emit('skip-stage', { stage }); continue; }
    // "work" for stageMs while heartbeating every second (keeps the 5 s lease alive)
    const until = Date.now() + stageMs;
    while (Date.now() < until) {
      await sleep(Math.min(1000, until - Date.now()));
      const hb = await workloads.heartbeat(workloadId, { ...fence, extend_ms: leaseMs });
      emit('heartbeat', { stage, expires_at: hb.expires_at });
    }
    scores[stage] = 10 * (i + 1);
    try {
      const cp = await workloads.checkpoint(workloadId, { ...fence, state: { stage, index: i + 1, score: scores[stage] } });
      emit('checkpoint', { stage, sequence: cp.sequence, attempt_id: cp.attempt_id });
    } catch (e) {
      const info = errInfo(e);
      if (info.code === 'WORKLOAD_TRANSITION_DENIED') {    // cancellation was requested
        await workloads.confirmCancelled(workloadId, fence);
        emit('cancel-confirmed', { stage });
        process.exit(0);
      }
      throw e;
    }
  }
  const output = { passed: true, total: Object.values(scores).reduce((a, b) => a + b, 0), scores };
  const result = await workloads.complete(workloadId, { ...fence, result_id: `result-${workloadId}`, output, artifacts: [], schema_version: 1 });
  emit('completed', { result_id: result.result_id, output: result.output });
} catch (e) {
  emit('error', errInfo(e));
  process.exit(2);
}
