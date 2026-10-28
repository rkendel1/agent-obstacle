// Dispatcher: polls the app, admits runs into Durable Work, relays cancellations, and hands READY
// workloads to the executor. Reconciliation is part of every tick: the authority's workload list is
// the truth, so after a restart READY work (new, or recovered after a lost lease) is claimed again
// and resumes from its checkpoints; work still leased to a dead worker is left until its lease
// expires; terminal work that the app has not seen as terminal is reported.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runsDir } from '../lib/paths.mjs';
import { readJSON, writeJSON, nowIso, sleep, canonicalDigest } from '../lib/util.mjs';
import { attemptRequest, errInfo, DEFINITION_ID, TERMINAL_STATES } from '../work-authority/client.mjs';
import { AttemptExecutor, withRetry } from '../worker/executor.mjs';
import { ADAPTERS } from '../agents/index.mjs';

/** Overall Durable Work timeout for an attempt: agent deadline + prepare/evaluation allowance. */
export function overallMs(experiment) {
  const d = experiment?.budgets?.deadlineSecs ?? 1200;
  return (d + 3 * 3600) * 1000;
}

export class Dispatcher {
  /**
   * @param {{app: object, state: object, executor?: AttemptExecutor, workerName?: string, concurrency?: number, pollMs?: number, log?: Function, adapters?: object, runsRoot?: string, coursesRoot?: string, sink?: object}} o
   * `app` is an AppClient (or the FakeApp in unit tests); `sink` defaults to AppSink(app).
   */
  constructor({ app, state, executor, sink, workerName, concurrency = Number(process.env.AOC_CONCURRENCY || 1), pollMs = Number(process.env.AOC_POLL_MS || 3000), log = console.log, adapters = ADAPTERS, runsRoot, coursesRoot, leaseMs }) {
    this.app = app; this.state = state; this.log = log; this.concurrency = concurrency; this.pollMs = pollMs; this.adapters = adapters; this.runsRoot = runsRoot;
    this.executor = executor ?? new AttemptExecutor({ state, workerName, sink, adapters, log, coursesRoot, runsRoot, leaseMs });
    this.workloads = this.executor.c.app;      // app (service) credential: create, list, inspect, cancel
    this.running = new Map();                   // workloadId -> Promise
    this.stopped = false;
    this.waitingLogged = new Set();
  }

  async admit() {
    const { runs = [] } = await this.app.pending(10);
    for (const r of runs) {
      const adapter = r.experiment?.agent?.adapter;
      if (!this.adapters[adapter]) { this.log(`run ${r.runId}: unknown adapter ${adapter}; admitting anyway (the attempt will report ERROR)`); }
      const input = { runId: r.runId, courseVersionId: r.courseVersionId, courseDigest: r.courseDigest, experiment: r.experiment, requestedAt: r.requestedAt, requestedBy: r.requestedBy };
      let w;
      try { w = await withRetry(() => this.workloads.create(attemptRequest({ state: this.state, runId: r.runId, input, overallMs: overallMs(r.experiment) }))); }
      catch (e) { this.log(`run ${r.runId}: admission refused: ${JSON.stringify(errInfo(e))}`); continue; }
      try {
        await this.app.admitted({ runId: r.runId, workloadId: w.workload_id, workAuthority: this.executor.workAuthority() });
        this.log(`run ${r.runId}: admitted as ${w.workload_id}`);
      } catch (e) {
        this.log(`run ${r.runId}: runs.admitted refused (${e.code ?? e.message}); cancelling workload ${w.workload_id}`);
        await this.workloads.cancel(w.workload_id, this.state.grants.cancel).catch(() => {});
      }
    }
    return runs.length;
  }

  async cancellations() {
    const { runs = [] } = await this.app.cancellations();
    for (const { runId, workloadId } of runs) {
      if (!workloadId) continue;      // never admitted: the app cancels it itself (contract)
      let w; try { w = await this.workloads.inspect(workloadId); } catch (e) { this.log(`inspect ${workloadId}: ${errInfo(e).code}`); continue; }
      if (!TERMINAL_STATES.has(w.state) && w.state !== 'CANCELLATION_REQUESTED') {
        try { await this.workloads.cancel(workloadId, this.state.grants.cancel); this.log(`run ${runId}: cancel requested at the work authority (${workloadId} was ${w.state})`); }
        catch (e) { this.log(`cancel ${workloadId}: ${JSON.stringify(errInfo(e))}`); }
        w = await this.workloads.inspect(workloadId).catch(() => w);
      }
      if (this.executor.cancelLocal(workloadId)) continue;     // our worker kills the agent and confirms
      if (w.state === 'CANCELLED') await this.reportCancelled(runId, workloadId, w);
      else if (w.state === 'CANCELLATION_REQUESTED') this.logOnce(`cancel:${workloadId}`, `run ${runId}: cancellation requested; the worker holding ${workloadId} is gone — waiting for its lease to expire`);
    }
  }

  /** A run cancelled without a live worker (unclaimed, or its worker died): report CANCELLED. */
  async reportCancelled(runId, workloadId, w) {
    const runDir = join(this.runsRoot ?? runsDir(), runId);
    const path = join(runDir, 'result.json');
    let result = existsSync(path) ? readJSON(path) : null;
    if (!result || result.outcome !== 'CANCELLED') {
      const input = w.input ?? {};
      result = {
        runId, workloadId, outcome: 'CANCELLED', claims: {}, observed: { durationMs: 0, timedOut: false },
        evaluation: { evaluatorVersion: (await import('../evaluator/index.mjs')).evaluatorVersion(), acceptance: 'not-run', regression: 'not-run', checks: [], violations: [] },
        metrics: {}, recovery: [],
        reproducibility: { courseDigest: input.courseDigest ?? '', experimentDigest: input.experiment?.digest ?? canonicalDigest(input.experiment ?? {}), evaluatorVersion: '', workAuthorityRelease: this.state.release, deterministic: false, note: `cancelled at the work authority while ${w.attempts?.length ? 'no live worker held it' : 'unclaimed'}` },
        startedAt: w.created_at ? new Date(Number(w.created_at) * 1000).toISOString() : nowIso(), completedAt: nowIso(),
      };
      result.reproducibility.evaluatorVersion = result.evaluation.evaluatorVersion;
      writeJSON(path, result);
    }
    await this.app.completed(result).then(() => this.log(`run ${runId}: reported CANCELLED`), (e) => this.log(`runs.completed ${runId}: ${e.message}`));
  }

  logOnce(key, msg) { if (!this.waitingLogged.has(key)) { this.waitingLogged.add(key); this.log(msg); } }

  async dispatch() {
    const list = (await this.workloads.list(this.state.appId)).workloads ?? [];
    const ours = list.filter((w) => w.definition_id === DEFINITION_ID || w.definition_id === undefined);
    let busy = 0;
    for (const w of ours) {
      if (this.running.has(w.workload_id)) { busy++; continue; }
      if (w.state === 'READY') {
        if (this.running.size >= this.concurrency) continue;
        const p = this.executor.execute(w.workload_id, { runId: w.idempotency_key })
          .then((r) => { if (r.claimed) this.log(`workload ${w.workload_id}: ${r.completed ? `completed (${r.result?.outcome})` : r.cancelled ? 'cancelled' : r.lost ? 'lease lost' : 'failed'}`); return r; })
          .catch((e) => this.log(`workload ${w.workload_id}: ${e.stack ?? e.message}`))
          .finally(() => this.running.delete(w.workload_id));
        this.running.set(w.workload_id, p);
        busy++;
      } else if (!TERMINAL_STATES.has(w.state)) {
        busy++;
        this.logOnce(`wait:${w.workload_id}:${w.state}`, `workload ${w.workload_id} is ${w.state} under another (or a lost) claim; waiting for completion or lease expiry`);
      } else if (w.state === 'DEAD_LETTER' || w.state === 'FAILED') {
        const runId = w.idempotency_key;
        const marker = join(this.runsRoot ?? runsDir(), runId, 'dead-letter-reported.json');
        if (!existsSync(marker)) {
          const result = buildDeadLetterResult(w, this.state);
          await this.app.completed(result).then(() => { writeJSON(marker, { at: nowIso(), state: w.state }); this.log(`run ${runId}: reported ERROR (${w.state})`); }, (e) => this.log(`runs.completed ${runId}: ${e.message}`));
        }
      }
    }
    return busy;
  }

  async tick() {
    let pending = 0, busy = 0;
    try { pending = await this.admit(); } catch (e) { this.log(`runs.pending: ${e.message}`); }
    try { await this.cancellations(); } catch (e) { this.log(`runs.cancellations: ${e.message}`); }
    try { busy = await this.dispatch(); } catch (e) { this.log(`work authority list: ${JSON.stringify(errInfo(e))}`); busy = 1; }
    return { pending, busy, running: this.running.size };
  }

  /** Long-running loop (npm run harness:start). */
  async start() {
    this.log(`dispatcher started (worker ${this.executor.workerName}, concurrency ${this.concurrency}, poll ${this.pollMs} ms)`);
    while (!this.stopped) { await this.tick(); await sleep(this.pollMs); }
    await Promise.allSettled(this.running.values());
  }

  /** Run ticks until nothing is pending, running or waiting (npm run harness:once; tests). */
  async once({ maxMs = 3600_000, pollMs = 500 } = {}) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const t = await this.tick();
      if (!t.pending && !t.busy && !this.running.size) break;
      await sleep(pollMs);
    }
    await Promise.allSettled(this.running.values());
    const t = await this.tick();
    await Promise.allSettled(this.running.values());
    return t;
  }

  stop() { this.stopped = true; }
}

function buildDeadLetterResult(w, state) {
  const input = w.input ?? {};
  return {
    runId: w.idempotency_key, workloadId: w.workload_id, outcome: 'ERROR', failureClass: 'harness', claims: {}, observed: { durationMs: 0, timedOut: false },
    evaluation: { evaluatorVersion: 'n/a', acceptance: 'not-run', regression: 'not-run', checks: [{ id: 'work-authority', result: 'error', detail: `workload ended ${w.state} after ${w.attempts?.length ?? '?'} attempt(s)` }], violations: [] },
    metrics: { attempts: w.attempts?.length ?? null }, recovery: [],
    reproducibility: { courseDigest: input.courseDigest ?? '', experimentDigest: input.experiment?.digest ?? '', evaluatorVersion: 'n/a', workAuthorityRelease: state.release, deterministic: false, note: `the work authority gave up on this attempt (${w.state})` },
    startedAt: nowIso(), completedAt: nowIso(),
  };
}
