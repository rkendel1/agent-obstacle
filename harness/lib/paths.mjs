// Where the harness keeps things. Nothing here is product state; the app and the work authority
// own that. `.harness/` (gitignored) holds local operational state: authority data and secrets,
// the fixture cache, model server pids. Run workspaces live OUTSIDE the repository.
import { join, dirname, resolve, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HARNESS_DIR = join(REPO_ROOT, 'harness');
export const COURSES_DIR = join(REPO_ROOT, 'courses');

export const stateDir = () => process.env.AOC_HARNESS_STATE_DIR || join(REPO_ROOT, '.harness');
export const fixturesDir = () => process.env.AOC_FIXTURES_DIR || join(stateDir(), 'fixtures');
/** Run directories (workspace, agent data, artifacts). Outside the repository by default. */
export const runsDir = () => process.env.AOC_RUNS_DIR || join(homedir(), '.aoc', 'runs');

/** First existing candidate: the explicit variable, then PATH, then the usual install locations. */
function locate(envVar, name, fallbacks) {
  if (process.env[envVar]) return process.env[envVar];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return fallbacks.find((p) => existsSync(p)) ?? fallbacks[0];
}

const home = homedir();
export const TOOLS = {
  stackAgent: locate('AOC_STACK_AGENT_BIN', 'stack-agent', [join(home, 'stack-agent/target/release/stack-agent'), '/home/user/stack-agent/target/release/stack-agent']),
  pax: locate('AOC_PAX_BIN', 'pax', [join(home, '.local/bin/pax'), join(home, '.cargo/bin/pax')]),
  feltdbServer: locate('FELTDB_SERVER_BIN', 'feltdb-server', [join(home, '.cargo/bin/feltdb-server'), '/opt/feltdb/bin/feltdb-server']),
  llmPython: process.env.AOC_LLM_PYTHON || '/opt/llm/venv/bin/python',
  modelsDir: process.env.AOC_MODELS_DIR || '/opt/llm/models',
};

const INSTALL = {
  feltdbServer: 'cargo install feltdb-server --version 0.3.0 --locked   (or set FELTDB_SERVER_BIN)',
  pax: 'install PAX 0.5.0 and put `pax` on PATH   (or set AOC_PAX_BIN)',
  stackAgent: 'build stack-agent (cargo build --locked --release --bin stack-agent) and put it on PATH   (or set AOC_STACK_AGENT_BIN)',
};

/** Path of a required tool, or an error that says how to install it. */
export function requireTool(key) {
  const p = TOOLS[key];
  if (!existsSync(p)) throw new Error(`${key === 'feltdbServer' ? 'feltdb-server' : key === 'stackAgent' ? 'stack-agent' : key} not found (looked at ${p}). Install: ${INSTALL[key]}`);
  return p;
}
