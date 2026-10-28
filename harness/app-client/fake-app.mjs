// In-memory stand-in for the FeltKit app, FOR UNIT TESTS OF HARNESS LOGIC ONLY. It implements the
// same methods as AppClient with the contract's idempotency/refusal rules, so dispatcher/worker
// logic can be tested without the real app. Integration tests and recorded runs never use it.
import { canonicalJSON } from '../lib/util.mjs';
import { AppPortError } from './index.mjs';

export class FakeApp {
  constructor() {
    this.runs = new Map();      // runId -> { pending, workloadId, cancelRequested, result, stages: [], events: Map(seq), evidence: Map }
    this.courseVersions = new Map();
    this.calls = [];
  }

  addCourseVersion(courseVersionId, version) { this.courseVersions.set(courseVersionId, version); }
  request(run) {
    if (!this.courseVersions.has(run.courseVersionId)) this.addCourseVersion(run.courseVersionId, { courseVersionId: run.courseVersionId, digest: run.courseDigest, status: 'published' });
    this.runs.set(run.runId, { pending: run, workloadId: null, cancelRequested: false, result: null, stages: [], events: new Map(), evidence: new Map(), admittedWith: null });
  }
  requestCancel(runId) { const r = this.runs.get(runId); r.cancelRequested = true; }
  run(runId) { return this.runs.get(runId); }

  #log(name, input) { this.calls.push({ name, input: JSON.parse(JSON.stringify(input ?? null)) }); }
  #get(runId) { const r = this.runs.get(runId); if (!r) throw new AppPortError('NOT_FOUND', `no run ${runId}`); return r; }

  async pending(limit = 10) {
    this.#log('runs.pending', { limit });
    return { runs: [...this.runs.values()].filter((r) => !r.workloadId && !r.result && !r.cancelRequested).slice(0, limit).map((r) => r.pending) };
  }
  async cancellations() {
    this.#log('runs.cancellations', {});
    return { runs: [...this.runs.entries()].filter(([, r]) => r.cancelRequested && !r.result).map(([runId, r]) => ({ runId, workloadId: r.workloadId })) };
  }
  async courseVersion(courseVersionId) {
    this.#log('courses.version', { courseVersionId });
    const v = this.courseVersions.get(courseVersionId);
    if (!v) throw new AppPortError('NOT_FOUND', `no course version ${courseVersionId}`);
    return { version: v };
  }
  async admitted(input) {
    this.#log('runs.admitted', input);
    const r = this.#get(input.runId);
    if (r.workloadId && r.workloadId !== input.workloadId) throw new AppPortError('CONFLICT', 'a different workload is already recorded for this run');
    r.workloadId = input.workloadId; r.admittedWith = input.workAuthority;
    return { ok: true };
  }
  async stage(input) { this.#log('runs.stage', input); this.#get(input.runId).stages.push(input); return { ok: true }; }
  async appendEvents(runId, events) {
    this.#log('runs.events.append', { runId, count: events.length });
    if (events.length > 200) throw new AppPortError('PAYLOAD_TOO_LARGE', 'at most 200 events per call');
    const r = this.#get(runId); let n = 0;
    for (const e of events) if (!r.events.has(e.seq)) { r.events.set(e.seq, e); n++; }
    return { appended: n };
  }
  async addEvidence(runId, items) {
    this.#log('runs.evidence.add', { runId, count: items.length });
    const r = this.#get(runId); let n = 0;
    for (const i of items) {
      if (i.content && Buffer.byteLength(i.content) > 256 * 1024) throw new AppPortError('PAYLOAD_TOO_LARGE', 'evidence content over 256 KiB');
      if (!r.evidence.has(i.evidenceId)) { r.evidence.set(i.evidenceId, i); n++; }
    }
    return { added: n };
  }
  async completed(result) {
    this.#log('runs.completed', { runId: result.runId, outcome: result.outcome });
    const r = this.#get(result.runId);
    if (result.outcome === 'PASS' && (result.evaluation?.acceptance !== 'pass' || result.evaluation.violations.some((v) => v.severity === 'critical' && v.completed))) {
      throw new AppPortError('INVALID_ARGUMENT', 'PASS without acceptance pass, or with a completed critical violation');
    }
    if (r.result) {
      if (canonicalJSON(r.result) !== canonicalJSON(result)) throw new AppPortError('CONFLICT', 'a different result is already recorded');
      return { ok: true };
    }
    r.result = result;
    return { ok: true };
  }
}
