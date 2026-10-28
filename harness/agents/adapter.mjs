// Agent adapter interface.
//
// An adapter runs ONE agent attempt in a prepared workspace and reports what happened. It is given:
//
//   AgentRequest {
//     runId, attempt,                // runId doubles as the agent's durable task id (resume)
//     objective: { goal, kind },     // course objective (the agent's brief; nothing evaluator-only)
//     workspace,                     // the agent's working directory (a copy of the fixture)
//     runDir,                        // per-run directory OUTSIDE the workspace (agent data, logs)
//     capabilities: string[],        // the course's allowed operation subset
//     budgets: { maxTurns, maxExecutions, deadlineSecs, callTimeoutSecs, maxOutputTokens? },
//     model: { endpoint, model, provider, structuredOutput? } | null,   // endpoint = the per-run harness proxy
//     env,                           // allowlisted base environment (see agentEnv); adapters add only their own vars
//     paxBin,                        // the PAX shim (obstacles + observation)
//     interruption,                  // process-interruption obstacle (or null)
//     course,                        // { doc, dir } — ONLY controls may read course.dir/evaluator
//     signal,                        // AbortSignal: cancel -> kill the agent's process group
//     emit(event), observe()         // stream RunEvents; observe() = live model/PAX counters
//     options,                       // experiment.agent.options
//   }
//
// and returns
//
//   AgentResult {
//     adapter, version, control?: boolean,     // controls are NOT agents and are labelled as such
//     claims:   { agentTerminalState?, agentSaysVerified?, summary? },  // what the agent SAYS
//     observed: { exitCode?, signal?, durationMs, timedOut, cancelled? }, // what the runtime saw
//     metrics:  { turns, executions, modelCalls, inputTokens, outputTokens, ... }  // null = not observed
//     observations: [...],                     // structured facts (e.g. agent-state summary)
//     artifacts: [{ label, path, kind }],      // files under runDir (report, stderr, agent state)
//     launches: [...],                         // each process launch (interruption -> several)
//     notRun?: { reason, failureClass },       // nothing ran (model unavailable, lock held, …)
//   }
import { dirname } from 'node:path';

/** Host variables that must never reach an agent (credentials of the harness host). */
export const DENY = /(^|_)(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?($|_)|^(OPENAI|ANTHROPIC|AWS|GOOGLE|AZURE|GH|GITHUB|HF|HUGGING)_|^FELTKIT_CREDENTIAL_|^FELTDB_|^AOC_HARNESS_API_KEY$/;

/**
 * The agent's base environment: an allowlist, never the host environment. No proxy settings, no
 * credentials. PATH puts the PAX shim first.
 */
export function agentEnv({ runDir, paxBin, home, extraPath = [] }) {
  const PATH = [dirname(paxBin), ...extraPath, dirname(process.execPath), '/root/.cargo/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const env = {
    PATH, HOME: home ?? process.env.HOME, LANG: 'C.UTF-8', TERM: 'dumb', CI: '1', NO_COLOR: '1',
    RUSTUP_TOOLCHAIN: 'stable', CARGO_TARGET_DIR: `${runDir}/target`, CARGO_INCREMENTAL: '0', CARGO_TERM_COLOR: 'never',
    PAX_BIN: paxBin,
  };
  for (const k of ['RUSTUP_HOME', 'CARGO_HOME']) if (process.env[k]) env[k] = process.env[k];
  for (const k of Object.keys(env)) if (DENY.test(k)) delete env[k];
  return env;
}

/** Resolve `credential-ref:<ID>` through FELTKIT_CREDENTIAL_<ID> (harness host custody). Never logged. */
export function resolveCredential(ref, env = process.env) {
  if (!ref) return null;
  const m = /^credential-ref:(.+)$/.exec(ref);
  if (!m) throw Object.assign(new Error('model.credentialRef must be a credential-ref: string'), { failureClass: 'harness' });
  const key = `FELTKIT_CREDENTIAL_${m[1].toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const v = env[key];
  if (!v) throw Object.assign(new Error(`credential reference ${ref} does not resolve (${key} is not set on the harness host)`), { failureClass: 'model' });
  return v;
}

export const emptyMetrics = () => ({ turns: null, executions: null, modelCalls: null, inputTokens: null, outputTokens: null, paxTests: null, writes: null, reads: null, modelFailures: null, malformedReplies: null, invalidDecisions: null, interruptions: null });
