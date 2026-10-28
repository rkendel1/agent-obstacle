// Controls: NOT agents. They calibrate that the harness + evaluator can produce each verdict.
//  * reference-control  applies the course's reference fix (course.evaluator.reference.file, private:
//                       never published, never in a workspace before this) to the workspace.
//                       Expected outcome PASS. Clearly labelled `control: true` in results.
//  * null-control       changes nothing (the base). Expected outcome FAIL.
// Option `holdMs` (both): wait that long, abortably, before acting — used by tests that need a
// stage that takes time (worker kill mid-stage, cancellation).
import { join } from 'node:path';
import { run } from '../lib/proc.mjs';
import { sleep, tail, sha256File } from '../lib/util.mjs';
import { emptyMetrics } from './adapter.mjs';

async function hold(ms, signal) {
  const end = Date.now() + (ms ?? 0);
  while (Date.now() < end) { if (signal?.aborted) return false; await sleep(Math.min(100, end - Date.now())); }
  return !signal?.aborted;
}

const result = (adapter, t0, { claims, cancelled = false, exitCode = 0, observations = [] }) => ({
  adapter, version: 'control-1', control: true, claims,
  observed: { exitCode, signal: null, durationMs: Date.now() - t0, timedOut: false, ...(cancelled ? { cancelled: true } : {}) },
  metrics: emptyMetrics(), launches: [], observations, artifacts: [],
});

export const referenceControl = {
  id: 'reference-control', control: true, needsModel: false, version: () => 'control-1',
  async run(req) {
    const t0 = Date.now();
    if (!(await hold(req.options?.holdMs, req.signal))) return result('reference-control', t0, { claims: { agentTerminalState: 'cancelled', summary: 'control (not an agent): cancelled before applying the reference fix' }, cancelled: true, exitCode: null });
    const decl = req.course.doc.evaluator?.reference;
    const ref = decl?.file;
    if (!ref) throw Object.assign(new Error('course has no evaluator.reference.file'), { failureClass: 'harness' });
    if (decl.digest && sha256File(join(req.course.dir, ref)) !== decl.digest) throw Object.assign(new Error(`reference fix ${ref} does not match its pinned digest`), { failureClass: 'harness' });
    const r = run('git', ['apply', '--whitespace=nowarn', join(req.course.dir, ref)], { cwd: req.workspace, env: req.env });
    req.emit({ source: 'harness', kind: 'control', summary: `reference-control (NOT an agent): ${r.code === 0 ? 'applied' : 'could not apply'} ${ref}`, data: { exit: r.code } });
    if (r.code !== 0) throw Object.assign(new Error(`reference fix does not apply: ${tail(r.stderr, 400)}`), { failureClass: 'harness' });
    return result('reference-control', t0, { claims: { agentTerminalState: 'control:reference-applied', summary: `control (not an agent): applied the course reference fix ${ref}` } });
  },
};

export const nullControl = {
  id: 'null-control', control: true, needsModel: false, version: () => 'control-1',
  async run(req) {
    const t0 = Date.now();
    if (!(await hold(req.options?.holdMs, req.signal))) return result('null-control', t0, { claims: { agentTerminalState: 'cancelled', summary: 'control (not an agent): cancelled' }, cancelled: true, exitCode: null });
    req.emit({ source: 'harness', kind: 'control', summary: 'null-control (NOT an agent): workspace left at the base' });
    return result('null-control', t0, { claims: { agentTerminalState: 'control:unchanged', summary: 'control (not an agent): no change' } });
  },
};
