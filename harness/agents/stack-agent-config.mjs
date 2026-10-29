// Experiment-level Stack-Agent configuration: which build runs, its context profile, prompt caching and run
// labels. Everything here comes from the experiment's agent.options (part of its digest), is validated before
// the agent starts, and is recorded with the run, so two arms of an A/B differ only where they say they do.
//
//   agent.options.build          name from stack-agent-builds.json (absent: the harness's default binary)
//   agent.options.contextProfile replay | auto | light | standard | deep | recovery  (absent: the build's default)
//   agent.options.promptCache    on | off                                           (absent: the build's default)
//   agent.options.runLabel       the arm / series label, e.g. "ab1-replay"           (absent: none)
//
// An option the selected build does not support is refused (not dropped): the run ends before the agent starts.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { sha256File } from '../lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTEXT_PROFILES = ['replay', 'auto', 'light', 'standard', 'deep', 'recovery'];
export const PROMPT_CACHE = ['on', 'off'];
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const configError = (message) => Object.assign(new Error(message), { failureClass: 'environment' });

export function loadBuilds(file = join(HERE, 'stack-agent-builds.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).builds ?? {};
}
export const buildsDir = () => process.env.AOC_STACK_AGENT_BUILDS_DIR || join(homedir(), '.aoc-bins');

const probes = new Map();
/** --version, sha256 and the flags `work --help` documents, once per binary. */
export function probeBinary(path) {
  if (probes.has(path)) return probes.get(path);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const version = run(path, ['--version'], { timeoutMs: 10_000, env }).stdout.trim() || null;
  const help = run(path, ['work', '--help'], { timeoutMs: 10_000, env });
  const text = `${help.stdout}\n${help.stderr}`;
  const p = {
    path, version, sha256: existsSync(path) ? sha256File(path) : null,
    flags: { contextProfile: text.includes('--context-profile'), promptCache: text.includes('--prompt-cache') },
  };
  probes.set(path, p);
  return p;
}

/**
 * Resolve and validate the experiment's Stack-Agent configuration. Throws (failureClass environment) on an unknown
 * build, a missing binary, an invalid value, or an option the binary does not support.
 */
export function resolveStackAgentConfig(options = {}, { builds = loadBuilds(), dir = buildsDir(), defaultBinary = TOOLS.stackAgent } = {}) {
  const { build, contextProfile, promptCache, runLabel } = options;
  if (contextProfile !== undefined && !CONTEXT_PROFILES.includes(contextProfile)) throw configError(`agent.options.contextProfile must be one of ${CONTEXT_PROFILES.join(', ')} (got ${JSON.stringify(contextProfile)})`);
  if (promptCache !== undefined && !PROMPT_CACHE.includes(promptCache)) throw configError(`agent.options.promptCache must be on or off (got ${JSON.stringify(promptCache)})`);
  if (runLabel !== undefined && !(typeof runLabel === 'string' && LABEL.test(runLabel))) throw configError(`agent.options.runLabel must be 1-64 characters of A-Z a-z 0-9 . _ : - (got ${JSON.stringify(runLabel)})`);
  let path = defaultBinary, entry = null;
  if (build !== undefined) {
    entry = builds[build];
    if (!entry) throw configError(`agent.options.build "${build}" is not a known Stack-Agent build (harness/agents/stack-agent-builds.json: ${Object.keys(builds).join(', ') || 'none'})`);
    path = join(dir, `stack-agent-${entry.commit}`);
    if (!existsSync(path)) throw configError(`Stack-Agent build "${build}" is not installed at ${path}. Build ${entry.repository}@${entry.commit} (${entry.build}) and copy target/release/stack-agent there.`);
  }
  const probe = probeBinary(path);
  if (contextProfile !== undefined && !probe.flags.contextProfile) throw configError(`${path} (${probe.version}) has no --context-profile; select a build that supports it`);
  if (promptCache !== undefined && !probe.flags.promptCache) throw configError(`${path} (${probe.version}) has no --prompt-cache; select a build that supports it`);
  return {
    binary: { build: build ?? null, commit: entry?.commit ?? null, path, sha256: probe.sha256, version: probe.version },
    contextProfile: contextProfile ?? null, promptCache: promptCache ?? null, runLabel: runLabel ?? null,
  };
}

/** Flags for `work` (only what the experiment set; nothing is added for an unset option). */
export function configArgs(cfg) {
  return [
    ...(cfg.contextProfile ? ['--context-profile', cfg.contextProfile] : []),
    ...(cfg.promptCache ? ['--prompt-cache', cfg.promptCache] : []),
  ];
}

/** CHIP_RUN_LABELS for the run (Stack-Agent's grammar: key=value, values printable ASCII without , or =). */
export function runLabels(cfg, { runId, courseRef, obstacle }) {
  const clean = (v) => String(v).replace(/[^\x21-\x7e]/g, '_').replace(/[,=]/g, '_').slice(0, 128);
  return [['run', runId], ['course', courseRef], ['obstacle', obstacle], ...(cfg.runLabel ? [['arm', cfg.runLabel]] : [])]
    .filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${clean(v)}`).join(',');
}

/** What the agent's own report says it actually ran with (the effective settings), never inferred. */
export function effectiveFromReport(rep) {
  if (!rep) return { contextProfile: null, promptCache: null, promptCacheSource: null, runLabels: null };
  const pc = rep.generation?.prompt_cache;
  return {
    contextProfile: rep.tuning?.context_profile ?? null,
    promptCache: pc && typeof pc === 'object' ? (pc.value === true ? 'on' : pc.value === false ? 'off' : pc.value ?? null) : (pc ?? null),
    promptCacheSource: pc && typeof pc === 'object' ? pc.source ?? null : null,
    runLabels: rep.token_usage?.run?.labels ?? null,
  };
}

/** Token totals from the agent's ledger: a sum only when every call reported the field (unknown stays null). */
export function tokenTotals(rep) {
  const t = rep?.token_usage?.totals;
  const pick = (name) => {
    const s = t?.[name];
    if (!s || typeof s !== 'object') return null;
    return (s.calls_unknown ?? 0) === 0 && typeof s.sum === 'number' ? s.sum : null;
  };
  return {
    cacheReadTokens: pick('cache_read_tokens'), cacheWriteTokens: pick('cache_write_tokens'),
    uncachedInputTokens: pick('uncached_input_tokens'), totalInputTokens: pick('total_input_tokens'),
  };
}
