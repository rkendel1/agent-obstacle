// Where the harness keeps things. Nothing here is product state; the app and the work authority
// own that. `.harness/` (gitignored) holds local operational state: authority data and secrets,
// the fixture cache, model server pids. Run workspaces live OUTSIDE the repository.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HARNESS_DIR = join(REPO_ROOT, 'harness');
export const COURSES_DIR = join(REPO_ROOT, 'courses');

export const stateDir = () => process.env.AOC_HARNESS_STATE_DIR || join(REPO_ROOT, '.harness');
export const fixturesDir = () => process.env.AOC_FIXTURES_DIR || join(stateDir(), 'fixtures');
/** Run directories (workspace, agent data, artifacts). Outside the repository by default. */
export const runsDir = () => process.env.AOC_RUNS_DIR || join(homedir(), '.aoc', 'runs');

export const TOOLS = {
  stackAgent: process.env.AOC_STACK_AGENT_BIN || '/home/user/stack-agent/target/release/stack-agent',
  pax: process.env.AOC_PAX_BIN || '/root/.local/bin/pax',
  feltdbServer: process.env.FELTDB_SERVER_BIN || '/opt/feltdb/bin/feltdb-server',
  llmPython: process.env.AOC_LLM_PYTHON || '/opt/llm/venv/bin/python',
  modelsDir: process.env.AOC_MODELS_DIR || '/opt/llm/models',
};
