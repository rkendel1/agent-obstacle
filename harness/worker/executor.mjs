// Durable Work execution of one aoc.attempt workload by one worker identity:
// claim (fencing token) → executionContext (input + checkpoints of earlier attempts) → start →
// stages with a checkpoint after each and heartbeats throughout → complete.
//  * lease lost (stale fence / no active claim): stop at once, kill the agent, report nothing — the
//    authority recovers the workload and another claim (higher fence) resumes from the checkpoints;
//  * cancellation (WORKLOAD_TRANSITION_DENIED on a fenced write, or relayed by the dispatcher):
//    kill the agent's process group, confirmCancelled, report outcome CANCELLED;
//  * transport failures to the authority are retried with the identical request (the server replays).
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { runsDir } from '../lib/paths.mjs';
import { sleep, nowIso, writeJSON, appendJSONL, errorInfo } from '../lib/util.mjs';
import { authorityClients, fenceOf, meshHeartbeat, errInfo } from '../work-authority/client.mjs';
import { workerFaultPlan } from '../obstacles/index.mjs';
import { Recorder } from './recorder.mjs';
import { runStages, buildResult, STAGES } from './stages.mjs';

const TRANSIENT = new Set(['COMMIT_OUTCOME_UNKNOWN', 'SERVICE_UNAVAILABLE', 'ECONNREFUSED', 'UND_ERR_SOCKET']);
export function isTransient(e) {
  const i = errInfo(e);
  if (i.status === undefined) return /fetch failed|ECONNREFUSED|ECONNRESET|socket|network|terminated|SERVICE_UNAVAILABLE|COMMIT_OUTCOME_UNKNOWN/i.test(`${i.code ?? ''} ${i.message}`);
  return TRANSIENT.has(i.code) || i.status === 502 || i.status === 503 || i.status === 504;
}

/** Retry the identical request on transport failure (the authority replays committed writes). */
export async function withRetry(fn, { tries = 60, delayMs = 500, maxDelayMs = 5000, onRetry } = {}) {
  let d = delayMs;
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isTransient(e) || i >= tries) throw e;
      onRetry?.(e, i);
      await sleep(d); d = Math.min(maxDelayMs, d * 2);
    }
  }
}

export const attemptNumberOf = (attemptId) => Number(String(attemptId ?? '').match(/(\d+)$/)?.[1] ?? 1);

export class AttemptExecutor {
  /**
   * @param {{state: object, workerName?: string, sink?: object, adapters?: object, leaseMs?: number, log?: Function, coursesRoot?: string, runsRoot?: string}} o
   */
  constructor({ state, workerName = process.env.AOC_WORKER || 'aoc-worker-a', sink = null, adapters, leaseMs = Number(process.env.AOC_LEASE_MS || 15_000), log = () => {}, coursesRoot, runsRoot }) {
    this.state = state; this.sink = sink; this.adapters = adapters; this.leaseMs = leaseMs; this.log = log; this.coursesRoot = coursesRoot; this.runsRoot = runsRoot;
    this.c = authorityClients(state, workerName);
    this.workerName = workerName;
    this.active = new Map();   // workloadId -> { controller, runId }
  }

  workAuthority() { return { url: this.state.url, namespace: this.state.namespace, release: this.state.release }; }

  /** Relay a cancellation (dispatcher saw it in runs.cancellations). */
  cancelLocal(workloadId) { const a = this.active.get(workloadId); if (a) { a.reason = 'cancelled'; a.controller.abort(new Error('cancelled')); return true; } return false; }

  async execute(workloadId, { runId: runIdHint } = {}) {
    const { workerWorkloads: W, workerMesh, worker } = this.c;
    const lease = this.leaseMs;
    await withRetry(() => meshHeartbeat(workerMesh, worker, 1)).catch((e) => this.log(`mesh heartbeat failed: ${e.message}`));
    let claim;
    try { claim = await withRetry(() => W.claim(workloadId, { worker_id: worker.id, lease_ms: lease, grant: worker.grant })); }
    catch (e) { const i = errInfo(e); this.log(`claim ${workloadId} refused: ${i.code ?? i.message}`); return { claimed: false, error: i }; }
    const fence = fenceOf(worker, claim);
    const ctxDoc = await withRetry(() => W.executionContext(workloadId, fence));
    const input = ctxDoc.input;
    const runId = input?.runId ?? runIdHint;
    const attemptNumber = attemptNumberOf(ctxDoc.attempt_id);
    const runDir = join(this.runsRoot ?? runsDir(), runId);
    const recorder = new Recorder(runId, runDir, this.sink, this.log);
    appendJSONL(join(runDir, 'claims.jsonl'), { workloadId, worker: worker.id, claim_id: claim.claim_id, fencing_token: claim.fencing_token, attempt_id: ctxDoc.attempt_id, at: nowIso() });
    recorder.emit({ source: 'harness', kind: attemptNumber > 1 ? 'recovery' : 'stage', summary: `claimed workload ${workloadId} as ${this.workerName} (fencing token ${claim.fencing_token}, attempt ${attemptNumber}, ${ctxDoc.checkpoints.length} prior checkpoint(s))`, data: { workloadId, fencingToken: claim.fencing_token, attempt: attemptNumber, prior: ctxDoc.checkpoints.map((c) => ({ seq: c.sequence, stage: c.state?.stage, attempt: c.attempt_id })) } });
    await withRetry(() => W.start(workloadId, fence)).catch((e) => { if (!/TRANSITION|ALREADY/.test(errInfo(e).code ?? '')) throw e; });

    const controller = new AbortController();
    const slot = { controller, runId, reason: null };
    this.active.set(workloadId, slot);
    const abort = (reason) => { if (!slot.reason) { slot.reason = reason; controller.abort(new Error(reason)); } };
    let hbFailures = 0;
    const hb = setInterval(async () => {
      try { await W.heartbeat(workloadId, { ...fence, extend_ms: lease }); hbFailures = 0; }
      catch (e) {
        const i = errInfo(e);
        if (i.code === 'WORKLOAD_TRANSITION_DENIED') abort('cancelled');
        else if (['WORKLOAD_STALE_FENCE', 'WORKLOAD_CLAIM_INVALID'].includes(i.code) || i.status === 403) abort('lease-lost');
        else if (++hbFailures % 5 === 1) this.log(`heartbeat ${workloadId} failed (${i.code ?? i.message}); retrying`);
      }
    }, Math.max(500, Math.floor(lease / 3)));

    // Prior checkpoints (this or earlier attempts): latest per stage.
    const done = new Map();
    for (const c of [...ctxDoc.checkpoints].sort((a, b) => a.sequence - b.sequence)) if (c.state?.stage && STAGES.includes(c.state.stage)) done.set(c.state.stage, c.state.data);
    const fault = workerFaultPlan();
    const faultMarker = join(runDir, '.fault-fired');
    const faultArmed = fault && !existsSync(faultMarker);
    const die = () => { writeFileSync(faultMarker, nowIso()); this.log(`FAULT: SIGKILL of the harness worker (${process.env.AOC_FAULT_KILL})`); process.kill(process.pid, 'SIGKILL'); };

    const ctx = { runId, workloadId, input, runDir, recorder, done, attemptNumber, signal: controller.signal, adapters: this.adapters, coursesRoot: this.coursesRoot, sink: this.sink, workAuthority: this.workAuthority() };
    const stageReport = async (stage, status, detail) => {
      if (faultArmed && status === 'started' && fault.stage === stage && typeof fault.when === 'number') setTimeout(die, fault.when);
      if (!this.sink) return;
      try { await this.sink.stage({ runId, workloadId, attemptNumber, fencingToken: claim.fencing_token, stage, status, at: nowIso(), ...(detail ? { detail } : {}) }); }
      catch (e) { this.log(`runs.stage ${stage}/${status} failed: ${e.message}`); }
    };
    let index = ctxDoc.checkpoints.length;
    const checkpoint = async (stage, data) => {
      try { await withRetry(() => W.checkpoint(workloadId, { ...fence, state: { stage, index: ++index, at: nowIso(), data } })); }
      catch (e) {
        const i = errInfo(e);
        if (i.code === 'WORKLOAD_TRANSITION_DENIED') { abort('cancelled'); throw e; }
        if (['WORKLOAD_STALE_FENCE', 'WORKLOAD_CLAIM_INVALID'].includes(i.code) || i.status === 403) { abort('lease-lost'); throw e; }
        throw Object.assign(e, { fatal: true });
      }
    };
    const afterStage = async (stage) => { if (faultArmed && fault.stage === stage && fault.when === 'after') die(); };

    try {
      const out = await runStages(ctx, { checkpoint, stageReport, afterStage });
      if (out.aborted) {
        if (slot.reason === 'lease-lost') {
          recorder.emit({ source: 'harness', kind: 'recovery', summary: `lease lost on ${workloadId} (fencing token ${claim.fencing_token}); stopping — another claim will resume from the checkpoints` });
          return { claimed: true, lost: true };
        }
        // cancelled
        await withRetry(() => W.confirmCancelled(workloadId, fence)).catch((e) => this.log(`confirmCancelled: ${errInfo(e).code ?? e.message}`));
        const result = buildResult(ctx, out.state, null, { cancelled: true });
        writeJSON(join(runDir, 'result.json'), result);
        recorder.emit({ source: 'harness', kind: 'cancel', summary: 'cancellation confirmed to the work authority; outcome CANCELLED', data: { workloadId } });
        await recorder.flush();
        if (this.sink) await withRetry(() => this.sink.completed(result)).catch((e) => this.log(`runs.completed (cancelled) failed: ${e.message}`));
        return { claimed: true, cancelled: true, result };
      }
      const result = out.result;
      await withRetry(() => W.complete(workloadId, { ...fence, result_id: `result-${workloadId}`, output: { outcome: result?.outcome ?? 'ERROR', failureClass: result?.failureClass ?? null, runId, resultFile: 'result.json' }, artifacts: [], schema_version: 1 }))
        .catch(async (e) => {
          const i = errInfo(e);
          if (i.code === 'WORKLOAD_TRANSITION_DENIED') { await W.confirmCancelled(workloadId, fence).catch(() => {}); return; }
          throw e;
        });
      recorder.emit({ source: 'harness', kind: 'stage', summary: `workload ${workloadId} completed at the work authority (outcome ${result?.outcome})` });
      await recorder.flush();
      return { claimed: true, completed: true, result };
    } catch (e) {
      if (slot.reason === 'lease-lost') return { claimed: true, lost: true };
      // A harness fault outside the stage pipeline: let Durable Work retry (effect unknown).
      this.log(`attempt ${workloadId} failed: ${e.stack ?? e.message}`);
      await W.fail(workloadId, { ...fence, kind: 'worker_failure', error: String(e.message).slice(0, 500), effect: 'unknown' }).catch(() => {});
      return { claimed: true, failed: true, error: errorInfo(e) };
    } finally {
      clearInterval(hb);
      this.active.delete(workloadId);
      await withRetry(() => meshHeartbeat(workerMesh, worker, this.active.size), { tries: 3 }).catch(() => {});
    }
  }
}
