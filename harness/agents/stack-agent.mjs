// Stack-Agent (Chip) adapter: the real CLI, `stack-agent work "<goal>" --json`.
// Contract: docs/integration/stack-agent.md. Key points encoded here:
//  * one positional goal (≤ 2,000 bytes), cwd = the project (the workspace);
//  * budgets as flags (--max-turns/--max-executions/--deadline-secs/--call-timeout-secs/--max-output-tokens),
//    ALSO enforced by the harness wall clock with a process-group kill;
//  * --task-id = runId and --state-db under the run dir: a relaunch after SIGKILL resumes the same task
//    once its lease (--lease-secs, kept above the call timeout) has expired;
//  * STACK_AGENT_DATA_DIR per run, outside the workspace; OPENAI_API_KEY/ANTHROPIC_API_KEY never passed
//    (the per-run model proxy holds any real credential; the agent gets a placeholder CHIP_API_KEY);
//  * after exit, the --json report (stdout, one line) and `agent-state show --json` are captured.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../lib/paths.mjs';
import { spawnGroup, killGroup, terminateGroup, groupAlive, run } from '../lib/proc.mjs';
import { sleep, sha256File, bounded, tail } from '../lib/util.mjs';
import { emptyMetrics } from './adapter.mjs';

let versionCache = null;
export function stackAgentVersion() {
  if (versionCache) return versionCache;
  const r = run(TOOLS.stackAgent, ['--version'], { timeoutMs: 10_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  versionCache = { version: r.stdout.trim() || null, sha256: existsSync(TOOLS.stackAgent) ? sha256File(TOOLS.stackAgent) : null };
  return versionCache;
}

function parseReport(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

/**
 * Settle intents whose outcome the killed attempt left unknown. Only pax.test intents are settled
 * (from the PAX shim log: did a test run start?); anything else is left for a human (it stays blocked).
 */
export function settleUnknown(req, { stateDb, env }) {
  const show = run(TOOLS.stackAgent, ['agent-state', 'show', '--state-db', stateDb, '--task-id', req.runId, '--json'], { cwd: req.workspace, env, timeoutMs: 60_000 });
  let st; try { st = JSON.parse(show.stdout); } catch { return []; }
  const shimLog = join(req.runDir, 'artifacts', 'pax-calls.jsonl');
  const ran = existsSync(shimLog) && readFileSync(shimLog, 'utf8').includes('"op":"test","phase":"start"');
  const out = [];
  for (const i of st.intents ?? []) {
    if (i.state === 'resolved' || !i.key) continue;
    const action = (i.action ?? '').split(' ')[0];
    if (action !== 'pax.test') { out.push({ intent: i.key, action, exit: null, note: 'not settled: only pax.test intents are settled from harness evidence' }); continue; }
    const r = run(TOOLS.stackAgent, ['agent-state', 'settle', '--state-db', stateDb, '--task-id', req.runId, '--intent', i.key, '--executed', ran ? 'true' : 'false',
      '--decided-by', 'aoc-harness-operator', '--evidence', "the harness's PAX shim log", '--json'], { cwd: req.workspace, env, timeoutMs: 60_000 });
    out.push({ intent: i.key, action, executed: ran, exit: r.code });
  }
  return out;
}

export function workArgs(req, { stateDb, leaseSecs, deadlineSecs }) {
  const b = req.budgets; const m = req.model;
  return ['work', req.objective.goal, '--kind', req.objective.kind ?? 'change',
    '--provider', m.provider === 'anthropic' ? 'anthropic' : 'openai-compatible', '--model', m.model, '--endpoint', m.endpoint,
    // Anthropic: its profile (no temperature, no schema) unless the experiment names a mode; Anthropic accepts only
    // schema-closed or none.
    ...(m.provider === 'anthropic'
      ? ['--provider-profile', req.options?.providerProfile ?? 'anthropic', ...((req.options?.structuredOutput ?? m.structuredOutput) ? ['--structured-output', req.options?.structuredOutput ?? m.structuredOutput] : [])]
      : ['--provider-profile', req.options?.providerProfile ?? 'local', '--structured-output', req.options?.structuredOutput ?? m.structuredOutput ?? 'schema']),
    ...(b.maxOutputTokens ? ['--max-output-tokens', String(b.maxOutputTokens)] : []),
    '--call-timeout-secs', String(b.callTimeoutSecs), '--max-turns', String(b.maxTurns), '--max-executions', String(b.maxExecutions),
    '--deadline-secs', String(Math.max(1, Math.ceil(deadlineSecs))),
    ...(req.options?.temperature !== undefined ? ['--temperature', String(req.options.temperature)] : []),
    '--state-db', stateDb, '--task-id', req.runId, '--lease-secs', String(leaseSecs), '--json'];
}

export const stackAgentAdapter = {
  id: 'stack-agent',
  control: false,
  needsModel: true,
  version: () => stackAgentVersion().version,

  async run(req) {
    if (!req.model) throw Object.assign(new Error('stack-agent needs a model selection'), { failureClass: 'harness' });
    if (Buffer.byteLength(req.objective.goal) > 2000) throw Object.assign(new Error('goal exceeds Stack-Agent\'s 2,000-byte limit'), { failureClass: 'harness' });
    const dataDir = join(req.runDir, 'agent-data');
    const outDir = join(req.runDir, 'agent');
    mkdirSync(dataDir, { recursive: true }); mkdirSync(outDir, { recursive: true });
    const stateDb = join(dataDir, 'state.feltdb');
    const b = req.budgets;
    const leaseSecs = req.options?.leaseSecs ?? Math.max(60, b.callTimeoutSecs + 60);
    const graceSecs = req.options?.deadlineGraceSecs ?? 60;
    const env = { ...req.env, STACK_AGENT_DATA_DIR: dataDir, CHIP_API_KEY: 'local-placeholder' };
    const t0 = Date.now();
    const hardDeadline = t0 + (b.deadlineSecs + graceSecs) * 1000;
    const launches = [];
    let interruption = req.interruption ? { ...req.interruption, fired: false } : null;
    let timedOut = false, cancelled = false, last = null;

    while (true) {
      const n = launches.length + 1;
      const remaining = (t0 + b.deadlineSecs * 1000 - Date.now()) / 1000;
      if (remaining <= 1) { timedOut = timedOut || launches.length > 0; break; }
      const reportPath = join(outDir, `report.${n}.json`), stderrPath = join(outDir, `stderr.${n}.log`);
      const args = workArgs(req, { stateDb, leaseSecs, deadlineSecs: remaining });
      const p = spawnGroup(TOOLS.stackAgent, args, { cwd: req.workspace, env, stdoutPath: reportPath, stderrPath, pidFile: join(req.runDir, 'agent.pgid') });
      req.emit({ source: 'harness', kind: 'agent.launch', summary: `stack-agent launch ${n} (task ${req.runId})`, data: { launch: n, pgid: p.pgid, deadlineSecs: Math.ceil(remaining), leaseSecs } });
      let reason = null;
      let hookFired = false;
      if (interruption && !interruption.fired && interruption.params?.trigger?.event === 'model.call' && req.hooks) {
        // Deterministic: the per-run proxy calls this before it replies, so the agent never sees the reply.
        req.hooks.onModelCall = (e) => { if (!interruption.fired && !hookFired && e.n >= (interruption.params.trigger.count ?? 1)) { hookFired = true; killGroup(p.pgid, 'SIGKILL'); } };
      }
      const onAbort = () => { reason = 'cancelled'; };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const exited = p.exited.then((r) => { reason ??= 'exit'; return r; });
      while (!reason) {
        await Promise.race([exited, sleep(200)]);
        if (reason) break;
        if (Date.now() > hardDeadline) { reason = 'deadline'; break; }
        if (interruption && !interruption.fired && interruption.params?.trigger?.afterSecs != null && Date.now() - t0 >= interruption.params.trigger.afterSecs * 1000) reason = 'interrupt';
      }
      req.signal?.removeEventListener('abort', onAbort);
      if (req.hooks) req.hooks.onModelCall = null;
      let exit;
      if (reason === 'exit' && interruption && !interruption.fired) {
        const r0 = await exited;
        // killed by the PAX shim (pax.test trigger) or by the proxy hook (model.call trigger)
        if (r0.signal === 'SIGKILL' && (hookFired || (interruption.marker && existsSync(interruption.marker)))) reason = 'interrupt';
      }
      if (reason === 'interrupt') {
        killGroup(p.pgid, 'SIGKILL');
        exit = await p.exited;
        interruption.fired = true;
        const killedAt = Date.now();
        req.emit({ source: 'harness', kind: 'obstacle.injected', summary: `process-interruption: SIGKILL of the agent's process group after ${JSON.stringify(interruption.params?.trigger)}`, data: { obstacleId: interruption.id, type: 'process-interruption', pgid: p.pgid, launch: n, trigger: interruption.params?.trigger } });
        launches.push({ n, exit: exit.code, signal: exit.signal, ms: exit.durationMs, interrupted: true });
        // Stack-Agent refuses a task held under an unexpired lease (exit 3): wait it out, then resume.
        const resumeAt = killedAt + (leaseSecs + 2) * 1000;
        req.emit({ source: 'harness', kind: 'recovery', summary: `waiting ${Math.round((resumeAt - Date.now()) / 1000)} s for the agent's lease to expire, then relaunching task ${req.runId}`, data: { leaseSecs } });
        while (Date.now() < resumeAt && !req.signal?.aborted) await sleep(250);
        if (req.signal?.aborted) { cancelled = true; break; }
        continue;
      }
      if (reason === 'cancelled' || reason === 'deadline') {
        const t = await terminateGroup(p.pgid, { graceMs: reason === 'cancelled' ? 5000 : 15_000 });
        exit = await p.exited;
        if (reason === 'cancelled') cancelled = true; else timedOut = true;
        req.emit({ source: 'harness', kind: reason === 'cancelled' ? 'cancel' : 'budget', summary: reason === 'cancelled' ? 'cancellation: agent process group terminated' : `deadline ${b.deadlineSecs}s (+${graceSecs}s grace) passed: agent process group terminated`, data: { pgid: p.pgid, sigkill: t.killed, groupGone: !groupAlive(p.pgid) } });
      } else exit = await exited;
      // An orphaned child (e.g. a test runner) must not outlive the agent.
      if (groupAlive(p.pgid)) await terminateGroup(p.pgid, { graceMs: 2000 });
      const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
      last = { n, exit: exit.code, signal: exit.signal, ms: exit.durationMs, report: parseReport(reportPath), reportPath, stderrPath, stderrTail: tail(stderr, 2000) };
      launches.push({ n, exit: exit.code, signal: exit.signal, ms: exit.durationMs, reason });
      // Resume refused because an action of the killed attempt has an unknown outcome: the harness
      // settles it as the operator, from its own evidence (the PAX shim log says whether a test ran).
      if (exit.code === 3 && /outcome is unknown/.test(stderr) && interruption?.fired && launches.length < 12 && !cancelled) {
        const settled = settleUnknown(req, { stateDb, env });
        req.emit({ source: 'harness', kind: 'recovery', summary: `operator settlement of ${settled.length} unresolved intent(s) from harness evidence; relaunching`, data: { settled } });
        if (settled.length && settled.every((x) => x.exit === 0)) continue;
      }
      // Resume refused because the lease of an interrupted attempt has not expired yet: retry shortly.
      if (exit.code === 3 && /unexpired lease/.test(stderr) && interruption?.fired && launches.length < 12 && !cancelled) {
        req.emit({ source: 'harness', kind: 'recovery', summary: 'agent lease not yet expired; retrying the relaunch in 5 s' });
        await sleep(5000);
        continue;
      }
      break;
    }

    // Durable record, read after exit (it is locked while the work runs).
    let agentState = null;
    const show = run(TOOLS.stackAgent, ['agent-state', 'show', '--state-db', stateDb, '--task-id', req.runId, '--json'], { cwd: req.workspace, env, timeoutMs: 60_000 });
    if (show.code === 0) { try { agentState = JSON.parse(show.stdout); } catch {} }
    writeFileSync(join(outDir, 'agent-state-show.json'), show.code === 0 ? show.stdout : JSON.stringify({ exit: show.code, stderr: tail(show.stderr, 2000) }));

    const rep = last?.report ?? null;
    const metrics = emptyMetrics();
    if (rep && rep.ran !== false) {
      Object.assign(metrics, {
        turns: rep.measurement?.turns ?? null, executions: rep.measurement?.executions ?? null, modelCalls: rep.measurement?.model_calls ?? null,
        inputTokens: rep.usage?.input_tokens ?? null, outputTokens: rep.usage?.output_tokens ?? null,
        paxTests: rep.executions_by_capability?.['pax.test'] ?? 0, writes: rep.writes ?? null, reads: rep.reads ?? null,
        modelFailures: Array.isArray(rep.model_failures) ? rep.model_failures.length : null, malformedReplies: rep.malformed_replies ?? null, invalidDecisions: rep.invalid_decisions ?? null,
      });
    }
    metrics.interruptions = launches.filter((l) => l.interrupted).length;
    const observed = { exitCode: last?.exit ?? null, signal: last?.signal ?? null, durationMs: Date.now() - t0, timedOut, ...(cancelled ? { cancelled: true } : {}) };
    const claims = rep ? {
      agentTerminalState: rep.terminal_state ?? (rep.ran === false ? `not-run:${rep.agent_state?.task?.status ?? 'terminal'}` : undefined),
      agentSaysVerified: typeof rep.verified === 'boolean' ? rep.verified : undefined,
      summary: bounded(rep.answer ?? rep.outcome_reason ?? '', 1024) || undefined,
    } : { agentTerminalState: cancelled ? 'cancelled' : 'no-report' };
    let notRun;
    if (!cancelled && last && last.exit === 2) throw Object.assign(new Error(`stack-agent usage error: ${last.stderrTail}`), { failureClass: 'harness' });
    if (!cancelled && last && last.exit === 3 && (!rep || rep.ran === false || (rep.measurement?.model_calls ?? 0) === 0)) {
      notRun = { reason: tail(last.stderrTail, 500), failureClass: /model|endpoint|connect|refused|unavailable|401|403|429/i.test(last.stderrTail) ? 'model' : 'environment' };
    }
    return {
      adapter: 'stack-agent', version: stackAgentVersion().version, binarySha256: stackAgentVersion().sha256, control: false,
      claims, observed, metrics, launches,
      observations: [
        { kind: 'agent.report', summary: rep ? { terminal_state: rep.terminal_state, verified: rep.verified, exit_status: rep.exit_status, outcome_reason: rep.outcome_reason, pax: rep.pax, audit: rep.audit, executions_by_capability: rep.executions_by_capability, paths_written: rep.paths_written, agent_state: rep.agent_state } : null },
        { kind: 'agent.state', summary: agentState ? { task: agentState.task, events: agentState.events?.length ?? null, results: agentState.results?.map((r) => r.verification) ?? null, unresolved: agentState.unresolved ?? null } : null },
      ],
      artifacts: [
        ...launches.map((l) => ({ label: `report.${l.n}.json`, path: join(outDir, `report.${l.n}.json`), kind: 'agent.report' })),
        ...launches.map((l) => ({ label: `stderr.${l.n}.log`, path: join(outDir, `stderr.${l.n}.log`), kind: 'log' })),
        { label: 'agent-state-show.json', path: join(outDir, 'agent-state-show.json'), kind: 'agent.report' },
      ],
      ...(notRun ? { notRun } : {}),
    };
  },
};
