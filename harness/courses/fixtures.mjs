// Fixture preparation, cached by recipe digest under .harness/fixtures/<digest>/{tree, fixture.json}.
//  * directory fixture: the course's fixture/ committed once into a fresh repository with a fixed
//    author and dates, so the base commit id is deterministic.
//  * git fixture: prepare-checkout.sh semantics — clone, detached checkout of the base, every
//    branch/remote ref deleted, origin removed, reflog expired, gc --prune=now (no newer history can
//    be read), then the install step (pnpm install --frozen-lockfile).
// A workspace is a full copy of the cached tree (the cache is never handed to an agent).
import { existsSync, mkdirSync, rmSync, renameSync, cpSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesDir } from '../lib/paths.mjs';
import { canonicalDigest, readJSON, writeJSON, treeDigest } from '../lib/util.mjs';
import { run } from '../lib/proc.mjs';

const GIT_IDENT = { GIT_AUTHOR_NAME: 'aoc-harness', GIT_AUTHOR_EMAIL: 'harness@aoc.local', GIT_COMMITTER_NAME: 'aoc-harness', GIT_COMMITTER_EMAIL: 'harness@aoc.local', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

/** Environment for prepare commands: host PATH/HOME plus proxy settings (network is needed to clone). */
function prepareEnv() {
  const keep = ['PATH', 'HOME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'npm_config_cafile', 'PNPM_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
  const env = { GIT_TERMINAL_PROMPT: '0', CI: '1' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function fixtureRecipe(course) {
  const f = course.doc.environment.fixture;
  if (f.type === 'directory') return { type: 'directory', course: `${course.id}/${course.version}`, digest: f.digest };
  return { type: 'git', repository: f.repository, commit: f.commit, install: f.install ?? null, strip: true };
}

const must = (r, what) => { if (r.code !== 0) throw Object.assign(new Error(`${what} failed (exit ${r.code}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr || r.stdout).slice(-800)}`), { failureClass: 'environment' }); return r; };

export function gitHead(dir) { return run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim(); }
export function gitRefs(dir) { return run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: dir }).stdout.trim(); }

/**
 * Prepare (or reuse) the cached fixture. Returns { dir: <cache dir>, tree, baseCommit, fixtureDigest, recipeDigest, refs, cached }.
 * `adopt` lets a caller hand over an already prepared checkout (moved into the cache). `root`
 * prepares into another cache directory (preflight prepares a second, independent copy).
 */
export function prepareFixture(course, { log = () => {}, adopt, root } = {}) {
  const recipe = fixtureRecipe(course);
  const recipeDigest = canonicalDigest(recipe);
  const dir = join(root ?? fixturesDir(), recipeDigest.slice(0, 16));
  const metaPath = join(dir, 'fixture.json');
  if (existsSync(metaPath)) {
    const meta = readJSON(metaPath);
    if (meta.recipeDigest === recipeDigest && existsSync(meta.tree)) return { ...meta, cached: true };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tree = join(dir, 'tree');
  const env = prepareEnv();
  const t0 = Date.now();
  if (recipe.type === 'directory') {
    cpSync(join(course.dir, course.doc.environment.fixture.path), tree, { recursive: true });
    const genv = { ...env, ...GIT_IDENT };
    must(run('git', ['init', '-q', '-b', 'main'], { cwd: tree, env: genv }), 'git init');
    must(run('git', ['add', '-A'], { cwd: tree, env: genv }), 'git add');
    must(run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `fixture ${course.id}/${course.version}`], { cwd: tree, env: genv }), 'git commit');
  } else {
    if (adopt && existsSync(adopt)) { log(`adopting prepared checkout ${adopt}`); renameSync(adopt, tree); }
    else {
      log(`cloning ${recipe.repository} @ ${recipe.commit.slice(0, 12)}`);
      must(run('git', ['clone', '--quiet', '--no-tags', recipe.repository, tree], { env, timeoutMs: 900_000 }), 'git clone');
      must(run('git', ['checkout', '--quiet', '--detach', recipe.commit], { cwd: tree, env }), 'git checkout');
      const refs = run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: tree, env }).stdout.split('\n').filter(Boolean);
      for (const r of refs) must(run('git', ['update-ref', '-d', r], { cwd: tree, env }), 'git update-ref');
      must(run('git', ['remote', 'remove', 'origin'], { cwd: tree, env }), 'git remote remove');
      must(run('git', ['reflog', 'expire', '--expire=now', '--all'], { cwd: tree, env }), 'git reflog expire');
      must(run('git', ['gc', '--quiet', '--prune=now'], { cwd: tree, env, timeoutMs: 900_000 }), 'git gc');
      if (recipe.install) { log(`install: ${recipe.install.join(' ')}`); must(run(recipe.install[0], recipe.install.slice(1), { cwd: tree, env, timeoutMs: 1800_000 }), 'install'); }
    }
    const head = gitHead(tree);
    if (head !== recipe.commit) throw Object.assign(new Error(`prepared HEAD ${head} is not ${recipe.commit}`), { failureClass: 'environment' });
  }
  const fixtureDigest = treeDigest(tree).digest;
  const meta = { recipe, recipeDigest, dir, tree, baseCommit: gitHead(tree), refs: gitRefs(tree), fixtureDigest, preparedAt: new Date().toISOString(), prepareMs: Date.now() - t0 };
  writeJSON(metaPath, meta);
  return { ...meta, cached: false };
}

/** Fresh workspace: a full copy of the cached tree, with .stack-agent/ git-excluded. */
export function createWorkspace(fixture, workspace) {
  rmSync(workspace, { recursive: true, force: true });
  cpSync(fixture.tree, workspace, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  appendFileSync(join(workspace, '.git', 'info', 'exclude'), '\n# agent runtime state (excluded from diffs and scoring by the harness)\n.stack-agent/\n');
  return workspace;
}
