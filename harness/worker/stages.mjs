// The attempt pipeline: prepare → observe-before → agent → observe-after → evaluate → report.
// Each stage is idempotent and returns a small JSON value that the executor checkpoints. A resumed
// attempt (new claim, higher fence) skips every stage that has a checkpoint and re-executes the
// first one that has none.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../lib/paths.mjs';
import { canonicalDigest, treeDigest, readJSON, writeJSON, nowIso, bounded } from '../lib/util.mjs';
import { run, groupAlive, terminateGroup } from '../lib/proc.mjs';
import { findCourseByDigest, validateCourse, loadCourseDir } from '../courses/index.mjs';
import { prepareFixture, createWorkspace } from '../courses/fixtures.mjs';
import { obstacleSchedule, installPaxShim, paxShimSummary, assessTransientRecovery } from '../obstacles/index.mjs';
import { paxObserve, workspaceDiff, workspaceStatus } from '../evidence/index.mjs';
import { evaluate, classify, evaluatorVersion } from '../evaluator/index.mjs';
import { getAdapter, ADAPTERS } from '../agents/index.mjs';
import { agentEnv, resolveCredential } from '../agents/adapter.mjs';
import { startModelProxy } from '../model-proxy/proxy.mjs';

export const STAGES = ['prepare', 'observe-before', 'agent', 'observe-after', 'evaluate', 'report'];
export const DEFAULT_MODEL_UPSTREAM = () => process.env.AOC_MODEL_UPSTREAM || 'http://127.0.0.1:8080';

export class StageError extends Error {
  constructor(message, failureClass = 'harness') { super(message); this.failureClass = failureClass; }
}

let paxVersionCache;
const paxVersion = () => (paxVersionCache ??= run(TOOLS.pax, ['--version'], { timeoutMs: 10_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } }).stdout.trim() || null);

export const experimentDigest = (experiment) => { const { digest, ...rest } = experiment ?? {}; return canonicalDigest(rest); };

/**
 * @param {object} ctx
 *   runId, input {courseDigest, courseVersionId, experiment}, runDir, recorder,
 *   done: Map(stage -> checkpoint data), attemptNumber, signal, adapters?, coursesRoot?, sink?, workAuthority?
 * @param {(stage, data) => Promise<void>} checkpoint
 * @param {(stage, status, detail?) => Promise<void>} stageReport
 * @returns {Promise<{result: object, outcome: string}>}
 */
export async function runStages(ctx, { checkpoint, stageReport, afterStage = async () => {} }) {
  const { recorder, done } = ctx;
  const adapters = ctx.adapters ?? ADAPTERS;
  const state = Object.fromEntries(done);
  let failure = null;
  for (const stage of STAGES) {
    if (done.has(stage)) {
      recorder.emit({ source: 'harness', kind: 'recovery', summary: `stage ${stage} already checkpointed (attempt ${ctx.attemptNumber}); skipped`, data: { stage } });
      continue;
    }
    if (stage !== 'report' && failure) continue;
    if (ctx.signal?.aborted) return { aborted: true, state };
    await stageReport(stage, 'started');
    recorder.emit({ source: 'harness', kind: 'stage', summary: `${stage} started`, data: { stage, status: 'started', attempt: ctx.attemptNumber } });
    await recorder.flush();
    let data;
    try {
      data = await STAGE_IMPL[stage](ctx, state, { adapters, failure });
      if (ctx.signal?.aborted) { state[stage] = data; return { aborted: true, state }; }
      state[stage] = data;
      await checkpoint(stage, data);
    } catch (e) {
      if (ctx.signal?.aborted) { if (data !== undefined) state[stage] = data; return { aborted: true, state }; }
      if (e.fatal) throw e;
      failure = { stage, message: e.message, failureClass: e.failureClass ?? 'harness' };
      delete state[stage];
      recorder.emit({ source: 'harness', kind: 'stage', summary: `${stage} failed: ${e.message}`, data: { stage, status: 'failed', failureClass: failure.failureClass } });
      await stageReport(stage, 'failed', { message: bounded(e.message, 2000), failureClass: failure.failureClass });
      state.failure = failure;
      continue;
    }
    recorder.emit({ source: 'harness', kind: 'stage', summary: `${stage} completed`, data: { stage, status: 'completed' } });
    await stageReport(stage, 'completed');
    await recorder.flush();
    await afterStage(stage);
  }
  return { result: readJSON(join(ctx.runDir, 'result.json'), null), outcome: state.report?.outcome, state };
}

function resolveCourse(ctx) {
  const c = findCourseByDigest(ctx.input.courseDigest, ctx.coursesRoot);
  if (!c) throw new StageError(`no local course version has digest ${ctx.input.courseDigest} (the app's course document must be byte-for-byte the course.json under courses/)`, 'harness');
  return c;
}

const STAGE_IMPL = {
  async prepare(ctx) {
    const { recorder, input } = ctx;
    const course = resolveCourse(ctx);
    if (ctx.sink?.courseVersion && input.courseVersionId) {
      const v = await ctx.sink.courseVersion(input.courseVersionId).then((r) => r.version, (e) => { throw new StageError(`courses.version: ${e.message}`, 'harness'); });
      if (v?.digest && v.digest !== input.courseDigest) throw new StageError(`course version ${input.courseVersionId} digest ${v.digest} differs from the run's ${input.courseDigest}`, 'harness');
    }
    const problems = validateCourse(course);
    if (problems.length) throw new StageError(`course ${course.id}/${course.version} is not valid: ${problems.join('; ')}`, 'harness');
    const schedule = obstacleSchedule(course.doc, input.experiment.obstacles);
    getAdapter(input.experiment.agent.adapter, ctx.adapters ?? ADAPTERS);
    let fixture;
    try { fixture = prepareFixture(course, { log: (m) => recorder.emit({ source: 'harness', kind: 'environment', summary: m }) }); }
    catch (e) { throw new StageError(`fixture preparation failed: ${e.message}`, 'environment'); }
    if (course.doc.environment.fixture.digest && fixture.fixtureDigest !== course.doc.environment.fixture.digest) throw new StageError(`prepared fixture digest ${fixture.fixtureDigest} does not match the course pin ${course.doc.environment.fixture.digest}`, 'environment');
    const workspace = join(ctx.runDir, 'workspace');
    createWorkspace(fixture, workspace);
    const digests = { courseDigest: course.digest, fixtureDigest: fixture.fixtureDigest, experimentDigest: input.experiment.digest ?? experimentDigest(input.experiment), experimentDigestComputed: experimentDigest(input.experiment), evaluatorDigest: course.doc.acceptance.evaluatorDigest };
    recorder.addEvidence({ evidenceId: 'digest:prepare', kind: 'digest', label: 'course, fixture and experiment digests', source: 'harness', content: { ...digests, baseCommit: fixture.baseCommit, course: `${course.id}/${course.version}`, fixtureCached: fixture.cached } });
    recorder.emit({ source: 'harness', kind: 'environment', summary: `workspace ready: ${course.id}/${course.version} @ ${fixture.baseCommit.slice(0, 12)} (${fixture.cached ? 'cached fixture' : 'fresh fixture'})`, data: { workspace, schedule: schedule.map((o) => o.id) } });
    return { course: { id: course.id, version: course.version, dir: course.dir }, fixture: { tree: fixture.tree, baseCommit: fixture.baseCommit, refs: fixture.refs, fixtureDigest: fixture.fixtureDigest }, workspace, schedule, digests, startedAt: nowIso() };
  },

  async 'observe-before'(ctx, state) {
    const obs = paxObserve(state.prepare.workspace, { env: agentEnv({ runDir: ctx.runDir, paxBin: TOOLS.pax }) });
    ctx.recorder.addEvidence({ evidenceId: 'pax.observation:before', kind: 'pax.observation', label: 'PAX info/doctor/reality/drift before the agent', source: 'pax', content: obs });
    for (const o of Object.values(obs)) ctx.recorder.emit({ source: 'pax', kind: 'verification', summary: `pax ${o.op} (before): ${o.status}`, data: { op: o.op, status: o.status, exit: o.exit } });
    return { pax: Object.fromEntries(Object.values(obs).map((o) => [o.op, o.status])) };
  },

  async agent(ctx, state, { adapters }) {
    const { recorder, input, runDir } = ctx;
    const exp = input.experiment;
    const adapter = getAdapter(exp.agent.adapter, adapters);
    const course = loadCourseDir(state.prepare.course.dir);
    const workspace = state.prepare.workspace;
    const startedMarker = join(runDir, 'agent.started');
    if (existsSync(startedMarker)) {
      // Re-execution after a lost worker: an orphaned agent group must not keep running.
      const pgid = Number(readFileSync(join(runDir, 'agent.pgid'), 'utf8').trim() || 0) || null;
      if (pgid && groupAlive(pgid)) { await terminateGroup(pgid, { graceMs: 3000 }); recorder.emit({ source: 'harness', kind: 'recovery', summary: `killed the orphaned agent process group ${pgid} of the lost attempt` }); }
      if (adapter.id !== 'stack-agent') {
        createWorkspace({ tree: state.prepare.fixture.tree }, workspace);
        recorder.emit({ source: 'harness', kind: 'recovery', summary: `${adapter.id} is not resumable: workspace reset to the fixture and the agent stage re-run from the start` });
      } else recorder.emit({ source: 'harness', kind: 'recovery', summary: `relaunching stack-agent with task id ${ctx.runId} (resume from its durable record)` });
    }
    writeFileSync(startedMarker, nowIso());
    const shim = installPaxShim({ binDir: join(runDir, 'bin'), logPath: join(runDir, 'artifacts', 'pax-calls.jsonl'), schedule: state.prepare.schedule, interruptViaShim: adapter.id === 'stack-agent' });
    const hooks = { onModelCall: null };
    const env = agentEnv({ runDir, paxBin: shim.bin });
    mkdirSync(join(runDir, 'target'), { recursive: true });
    const watchedNow = () => ({ fixture: treeDigest(state.prepare.fixture.tree).digest, evaluator: treeDigest(join(course.dir, 'evaluator'), { exclude: [] }).digest });
    const watchedBefore = watchedNow();

    let proxy = null, model = null;
    if (adapter.needsModel) {
      if (!exp.model) throw new StageError(`${adapter.id} needs a model selection in the experiment`, 'harness');
      const credential = resolveCredential(exp.model.credentialRef);
      const upstream = exp.model.endpoint || DEFAULT_MODEL_UPSTREAM();
      proxy = await startModelProxy({
        upstream, credential, log: join(runDir, 'artifacts', 'model-calls.jsonl'), callTimeoutMs: exp.budgets.callTimeoutSecs * 1000 + 30_000,
        tokenBudget: exp.model.inference?.maxTotalTokens ?? null, mode: exp.model.inference?.structuredOutputMode ?? 'translate',
        beforeReply: (c) => hooks.onModelCall?.(c),
        onCall: (c) => recorder.emit({ source: 'harness', kind: 'model.call', summary: `model call ${c.n}: HTTP ${c.status} in ${c.secs}s${c.usage ? `, ${c.usage.prompt_tokens}+${c.usage.completion_tokens} tokens` : ''}${c.finish ? `, ${c.finish}` : ''}`, data: { n: c.n, status: c.status, secs: c.secs, usage: c.usage, finish: c.finish, request_bytes: c.request_bytes } }),
      });
      model = { endpoint: proxy.endpoint, model: exp.model.model, provider: exp.model.provider, structuredOutput: exp.model.inference?.structuredOutput };
      recorder.emit({ source: 'harness', kind: 'model.call', summary: `per-run model proxy ${proxy.endpoint} -> ${upstream.replace(/\/\/[^@/]*@/, '//')}`, data: { model: exp.model.model, provider: exp.model.provider, credential: exp.model.credentialRef ? 'credential-ref (resolved on the harness host)' : 'none' } });
    }
    const pi = state.prepare.schedule.find((o) => o.type === 'process-interruption');
    const interruption = pi ? { ...pi, marker: shim.config.interrupt?.marker ?? null } : null;
    let result;
    try {
      result = await adapter.run({
        runId: ctx.runId, attempt: ctx.attemptNumber, objective: { goal: course.doc.objective.goal, kind: course.doc.objective.kind },
        workspace, runDir, capabilities: course.doc.capabilities.allowed, budgets: exp.budgets, model, env, paxBin: shim.bin,
        interruption: adapter.id === 'stack-agent' ? interruption : null, hooks, course, signal: ctx.signal, options: exp.agent.options ?? {},
        emit: (e) => recorder.emit(e),
        observe: () => ({ modelCalls: proxy?.stats.calls ?? 0, paxTests: paxShimSummary(shim.log).entries.filter((x) => x.op === 'test' && x.phase === 'end').length }),
      });
    } finally { await proxy?.close(); }
    if (interruption && adapter.id !== 'stack-agent') recorder.emit({ source: 'harness', kind: 'obstacle.skipped', summary: `process-interruption applies to resumable agents only; not injected for ${adapter.id}` });

    const watchedAfter = watchedNow();
    const shimSummary = paxShimSummary(shim.log);
    for (const inj of shimSummary.injections) {
      if (!recorder.events.has((e) => e.kind === 'obstacle.injected' && e.data?.type === 'transient-test-failure' && e.data?.n === inj.n)) {
        recorder.emit({ source: 'harness', kind: 'obstacle.injected', summary: `transient-test-failure: pax test invocation ${inj.n} failed transiently (exit ${inj.exit}, PAX status error/transient-infrastructure-failure)`, data: { obstacleId: state.prepare.schedule.find((o) => o.type === 'transient-test-failure')?.id, type: 'transient-test-failure', n: inj.n } });
      }
    }
    for (const t of shimSummary.tests.filter((t) => !t.injected)) recorder.emit({ source: 'pax', kind: 'tool.result', summary: `agent's pax test #${t.n}: ${t.status}${t.reason ? ` (${t.reason})` : ''}`, data: t });
    const recovery = [];
    for (const o of state.prepare.schedule) {
      if (o.type === 'transient-test-failure') recovery.push(assessTransientRecovery(o, shimSummary));
      if (o.type === 'process-interruption') {
        const fired = (result.metrics?.interruptions ?? 0) > 0;
        const lastReport = result.observations?.find((x) => x.kind === 'agent.report')?.summary;
        recovery.push({ obstacleId: o.id, injected: fired && adapter.id === 'stack-agent', recognized: null, recovered: fired ? !!(lastReport?.agent_state?.resumed_from || (lastReport?.agent_state?.attempt ?? 0) > 1) : null, detail: fired ? `relaunched with task id ${ctx.runId}; resumed_from=${lastReport?.agent_state?.resumed_from ?? 'n/a'}, attempt=${lastReport?.agent_state?.attempt ?? 'n/a'}` : 'trigger not reached' });
      }
    }
    if (ctx.attemptNumber > 1) recovery.push({ obstacleId: 'harness-worker-recovery', injected: !!process.env.AOC_FAULT_KILL, recognized: null, recovered: true, detail: `Durable Work attempt ${ctx.attemptNumber}: the agent stage was re-executed after a lost worker` });

    writeJSON(join(runDir, 'agent-result.json'), result);
    for (const a of result.artifacts ?? []) if (existsSync(a.path)) recorder.addEvidence({ evidenceId: `agent:${a.label}`, kind: a.kind, label: a.label, source: 'agent', content: readFileSync(a.path, 'utf8') });
    recorder.addEvidence({ evidenceId: 'process:agent', kind: 'process', label: 'agent process exit, signal, timing and launches', source: 'runtime', content: { adapter: result.adapter, control: !!result.control, observed: result.observed, launches: result.launches, notRun: result.notRun ?? null } });
    if (existsSync(shim.log)) recorder.addEvidence({ evidenceId: 'pax.test:agent', kind: 'pax.test', label: "the agent's PAX invocations (shim log)", source: 'harness', content: readFileSync(shim.log, 'utf8') });
    if (proxy && existsSync(join(runDir, 'artifacts', 'model-calls.jsonl'))) recorder.addEvidence({ evidenceId: 'log:model-calls', kind: 'log', label: 'model call metadata (per-run proxy; no prompt bodies)', source: 'harness', content: readFileSync(join(runDir, 'artifacts', 'model-calls.jsonl'), 'utf8') });
    recorder.emit({ source: 'agent', kind: 'claim', summary: `${result.control ? 'control' : 'agent'} claims: ${result.claims.agentTerminalState ?? 'n/a'}; verified=${result.claims.agentSaysVerified ?? 'n/a'}`, data: result.claims });
    return {
      agent: { adapter: result.adapter, version: result.version, control: !!result.control, claims: result.claims, observed: result.observed, metrics: result.metrics, launches: result.launches, notRun: result.notRun ?? null },
      proxy: proxy ? { ...proxy.stats } : null, shim: { tests: shimSummary.tests.length, injected: shimSummary.injections.length, lastReal: shimSummary.lastReal },
      recovery, watched: { before: watchedBefore, after: watchedAfter },
    };
  },

  async 'observe-after'(ctx, state) {
    const ws = state.prepare.workspace;
    const obs = paxObserve(ws, { env: agentEnv({ runDir: ctx.runDir, paxBin: TOOLS.pax }) });
    ctx.recorder.addEvidence({ evidenceId: 'pax.observation:after', kind: 'pax.observation', label: 'PAX info/doctor/reality/drift after the agent', source: 'pax', content: obs });
    for (const o of Object.values(obs)) ctx.recorder.emit({ source: 'pax', kind: 'verification', summary: `pax ${o.op} (after): ${o.status}`, data: { op: o.op, status: o.status, exit: o.exit } });
    const d = workspaceDiff(ws, state.prepare.fixture.baseCommit, { tmpDir: join(ctx.runDir, 'tmp') });
    ctx.recorder.addEvidence({ evidenceId: 'diff:agent', kind: 'diff', label: 'workspace diff vs the base (excluding .stack-agent/)', source: 'harness', content: d.diff });
    ctx.recorder.addEvidence({ evidenceId: 'log:git-status', kind: 'log', label: 'git status (excluding .stack-agent/)', source: 'harness', content: workspaceStatus(ws) });
    for (const f of d.files) ctx.recorder.emit({ source: 'harness', kind: 'file.change', summary: `${f.status} ${f.path}`, data: f });
    const finalTreeDigest = treeDigest(ws).digest;
    ctx.recorder.addEvidence({ evidenceId: 'digest:final', kind: 'digest', label: 'final workspace tree digest', source: 'harness', content: { finalTreeDigest, diffDigest: d.digest, changedFiles: d.files.length } });
    return { pax: Object.fromEntries(Object.values(obs).map((o) => [o.op, o.status])), finalTreeDigest, diffDigest: d.digest, changedFiles: d.files.map((f) => `${f.status} ${f.path}`).slice(0, 50) };
  },

  async evaluate(ctx, state) {
    const course = loadCourseDir(state.prepare.course.dir);
    const outDir = join(ctx.runDir, 'eval');
    const t0 = Date.now();
    const evaluation = await evaluate({ course, fixture: state.prepare.fixture, workspace: state.prepare.workspace, outDir, agent: state.agent.agent, budgets: ctx.input.experiment.budgets, watched: state.agent.watched });
    const verdict = { acceptance: evaluation.acceptance, regression: evaluation.regression, checks: evaluation.checks, violations: evaluation.violations, error: evaluation.error ?? null, evalTreeDigest: evaluation.evalTreeDigest ?? null, steps: evaluation.steps };
    ctx.recorder.addEvidence({ evidenceId: 'acceptance:verdict', kind: 'acceptance', label: 'independent evaluation verdict', source: 'evaluator', content: { evaluatorVersion: evaluation.evaluatorVersion, ...verdict } });
    for (const s of evaluation.steps ?? []) {
      const p = join(outDir, `${s.name}.log`);
      if (existsSync(p)) ctx.recorder.addEvidence({ evidenceId: `acceptance:${s.name}`, kind: 'acceptance', label: `evaluator step ${s.name}${s.recordOnly ? ' (recorded, not scored)' : ''}`, source: 'evaluator', content: bounded(readFileSync(p, 'utf8'), 200 * 1024) });
    }
    for (const c of evaluation.checks) ctx.recorder.emit({ source: 'evaluator', kind: 'verification', summary: `${c.id}: ${c.result}${c.detail ? ` — ${c.detail}` : ''}`, data: c });
    const cls = classify({ agent: state.agent.agent, evaluation });
    ctx.recorder.emit({ source: 'evaluator', kind: 'verification', summary: `outcome ${cls.outcome}${cls.failureClass ? ` (${cls.failureClass})` : ''}; the agent's claim was not consulted`, data: cls });
    rmSync(join(outDir, 'target'), { recursive: true, force: true });
    return { evaluation: { evaluatorVersion: evaluation.evaluatorVersion, acceptance: evaluation.acceptance, regression: evaluation.regression, checks: evaluation.checks.map((c) => ({ ...c, detail: c.detail ? bounded(c.detail, 600) : undefined })), violations: evaluation.violations }, outcome: cls.outcome, failureClass: cls.failureClass ?? null, ms: Date.now() - t0 };
  },

  async report(ctx, state, { failure }) {
    const resultPath = join(ctx.runDir, 'result.json');
    let result = existsSync(resultPath) ? readJSON(resultPath) : null;
    if (!result) {
      result = buildResult(ctx, state, failure);
      writeJSON(resultPath, result);
    }
    if (ctx.sink) await ctx.sink.completed(result);
    ctx.recorder.addEvidence({ evidenceId: 'log:run-result', kind: 'log', label: 'RunResult as reported to the app', source: 'harness', content: result });
    ctx.recorder.emit({ source: 'harness', kind: 'stage', summary: `reported outcome ${result.outcome}${result.failureClass ? ` (${result.failureClass})` : ''}`, data: { outcome: result.outcome } });
    return { outcome: result.outcome, failureClass: result.failureClass ?? null, resultDigest: canonicalDigest(result) };
  },
};

/** RunResult (docs/contracts/harness-app.md) from checkpointed stage data only. */
export function buildResult(ctx, state, failure, { cancelled = false } = {}) {
  const exp = ctx.input.experiment;
  const agent = state.agent?.agent ?? null;
  const ev = state.evaluate?.evaluation ?? null;
  const cls = cancelled ? { outcome: 'CANCELLED' } : failure ? classify({ harnessError: failure, agent }) : { outcome: state.evaluate?.outcome ?? 'ERROR', failureClass: state.evaluate?.failureClass ?? (state.evaluate ? undefined : 'harness') };
  const m = agent?.metrics ?? {};
  const proxy = state.agent?.proxy ?? null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const evaluation = ev ?? { evaluatorVersion: evaluatorVersion(), acceptance: cancelled ? 'not-run' : failure ? 'not-run' : 'error', regression: 'not-run', checks: failure ? [{ id: `stage:${failure.stage}`, result: 'error', detail: bounded(failure.message, 600) }] : [], violations: [] };
  const deterministicCourse = loadedMeta(state)?.deterministic === true;
  return {
    runId: ctx.runId, workloadId: ctx.workloadId ?? null, outcome: cls.outcome, ...(cls.failureClass ? { failureClass: cls.failureClass } : {}),
    claims: agent?.claims ?? {},
    observed: { ...(agent?.observed?.exitCode != null ? { exitCode: agent.observed.exitCode } : {}), ...(agent?.observed?.signal ? { signal: agent.observed.signal } : {}), durationMs: agent?.observed?.durationMs ?? 0, timedOut: !!agent?.observed?.timedOut },
    evaluation,
    metrics: {
      agentDurationMs: num(agent?.observed?.durationMs), turns: num(m.turns), executions: num(m.executions), modelCallsReported: num(m.modelCalls),
      modelCallsObserved: proxy ? proxy.calls : null, inputTokensReported: num(m.inputTokens), outputTokensReported: num(m.outputTokens),
      promptTokensObserved: proxy && proxy.usageReported ? proxy.promptTokens : null, completionTokensObserved: proxy && proxy.usageReported ? proxy.completionTokens : null,
      paxTestsObserved: state.agent?.shim ? state.agent.shim.tests : null, paxTestsInjected: state.agent?.shim ? state.agent.shim.injected : null,
      filesChanged: state['observe-after'] ? state['observe-after'].changedFiles.length : null, modelFailures: num(m.modelFailures), malformedReplies: num(m.malformedReplies),
      interruptions: num(m.interruptions), evaluationMs: num(state.evaluate?.ms), attempts: ctx.attemptNumber ?? 1,
    },
    recovery: state.agent?.recovery ?? [],
    reproducibility: {
      courseDigest: ctx.input.courseDigest, ...(state.prepare ? { fixtureDigest: state.prepare.fixture.fixtureDigest } : {}),
      ...(state['observe-after'] ? { finalTreeDigest: state['observe-after'].finalTreeDigest } : {}),
      experimentDigest: exp.digest ?? experimentDigest(exp), ...(agent?.version ? { agentVersion: `${agent.adapter} ${agent.version}` } : {}),
      paxVersion: paxVersion() ?? undefined, evaluatorVersion: evaluation.evaluatorVersion, ...(ctx.workAuthority ? { workAuthorityRelease: ctx.workAuthority.release } : {}),
      deterministic: !!(agent?.control && deterministicCourse),
      note: agent?.control ? `${agent.adapter} is a CONTROL, not an agent: it calibrates the harness and evaluator.` : 'Model-driven agent runs are not deterministic (even at temperature 0); repeat runs to compare.',
    },
    startedAt: state.prepare?.startedAt ?? nowIso(), completedAt: nowIso(),
  };
}

function loadedMeta(state) {
  try { return state.prepare ? readJSON(join(state.prepare.course.dir, 'course.json')).meta : null; } catch { return null; }
}
