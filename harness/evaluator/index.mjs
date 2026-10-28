// Independent evaluator. It never consults the agent's claim for correctness: the claim is
// recorded separately (RunResult.claims) and the outcome comes only from what this module runs.
//
// For each course (generic over course.acceptance; for course-001 this is run-acceptance.sh T4
// semantics):
//  1. base check: HEAD and refs of the agent workspace vs the fixture (commits are a violation);
//  2. the agent's diff against the base (tracked + committed + new untracked, `.stack-agent/` excluded);
//  3. constraint checks: evaluator paths present, forbidden paths modified, budgets, files outside
//     the workspace (watched locations), commits;
//  4. a FRESH evaluation tree = pristine cached fixture + the agent's diff (so ignored files the agent
//     wrote — node_modules, target/, .stack-agent/ — cannot influence the evaluator);
//  5. install (if any), record-only commands, the regression command (one rerun when only known-flaky
//     files fail; both recorded), then the hidden acceptance files copied in from the course's
//     evaluator/ directory and their commands run;
//  6. classification: PASS / FAIL / BLOCKED / ERROR / CANCELLED + failureClass.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroup, run } from '../lib/proc.mjs';
import { sha256, tail, treeDigest } from '../lib/util.mjs';
import { workspaceDiff, workspaceStatus } from '../evidence/index.mjs';
import { gitHead, gitRefs } from '../courses/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** name@version+<12 hex of sha256 over this directory's files> */
export function evaluatorVersion() {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  const files = readdirSync(HERE).filter((f) => statSync(join(HERE, f)).isFile()).sort();
  const digest = sha256(files.map((f) => `${f}\0${sha256(readFileSync(join(HERE, f)))}`).join('\n'));
  return `${pkg.name}@${pkg.version}+${digest.slice(0, 12)}`;
}

export function evaluatorEnv(evalDir) {
  return {
    PATH: [dirname(process.execPath), '/root/.cargo/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: process.env.HOME, LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0',
    RUSTUP_TOOLCHAIN: 'stable', CARGO_TARGET_DIR: join(evalDir, 'target'), CARGO_INCREMENTAL: '0', CARGO_TERM_COLOR: 'never',
    ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}), ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
  };
}

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const matches = (path, patterns) => patterns.some((p) => globToRe(p).test(path));

/** Parse test counts and failing files/tests from vitest or cargo output. */
export function parseTestOutput(text) {
  const out = { passed: null, failed: null, skipped: null, failing: [] };
  const v = text.match(/^\s*Tests\s+(.+)$/m);
  if (v) {
    const n = (k) => { const m = v[1].match(new RegExp(`(\\d+) ${k}`)); return m ? Number(m[1]) : 0; };
    out.passed = n('passed'); out.failed = n('failed'); out.skipped = n('skipped');
  }
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) {
    out.passed = cargo.reduce((a, m) => a + Number(m[1]), 0); out.failed = cargo.reduce((a, m) => a + Number(m[2]), 0); out.skipped = cargo.reduce((a, m) => a + Number(m[3]), 0);
  }
  const files = new Set();
  for (const m of text.matchAll(/^\s*(?:FAIL|❯|×)\s+([\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?)/gm)) files.add(m[1]);
  for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) files.add(m[1]);
  out.failing = [...files].sort();
  return out;
}

async function step(name, argv, { cwd, env, timeoutMs, outDir }) {
  const r = await runGroup(argv[0], argv.slice(1), { cwd, env, timeoutMs });
  const text = `$ ${argv.join(' ')}\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.timedOut ? ' (timed out)' : ''} in ${r.durationMs} ms\n`;
  writeFileSync(join(outDir, `${name}.log`), text);
  return { name, argv, exit: r.code, signal: r.signal, timedOut: r.timedOut, ms: r.durationMs, parsed: parseTestOutput(r.stdout + '\n' + r.stderr), logTail: tail(r.stdout + '\n' + r.stderr, 3000) };
}

/**
 * @param {object} p
 * @param {{doc: object, dir: string}} p.course
 * @param {{tree: string, baseCommit: string, refs: string}} p.fixture   the pristine cached fixture
 * @param {string} p.workspace         the agent's final workspace
 * @param {string} p.outDir            evaluator output directory (created; the fresh tree goes in outDir/tree)
 * @param {object} [p.agent]           agent result (only budgets/observed facts are read; never the claim)
 * @param {object} [p.budgets]
 * @param {object} [p.watched]         { before: {label: digest}, after: {label: digest} }
 */
export async function evaluate({ course, fixture, workspace, outDir, agent = null, budgets = null, watched = null, keepTree = false }) {
  const version = evaluatorVersion();
  const acc = course.doc.acceptance;
  mkdirSync(outDir, { recursive: true });
  const checks = []; const violations = [];
  const record = { evaluatorVersion: version, startedAt: new Date().toISOString() };

  // 1. base check
  const head = gitHead(workspace);
  const refs = gitRefs(workspace);
  const committed = head !== fixture.baseCommit || refs !== fixture.refs;
  checks.push({ id: 'base-commit', result: head === fixture.baseCommit ? 'pass' : 'fail', detail: `HEAD ${head.slice(0, 12)} (base ${fixture.baseCommit.slice(0, 12)})` });
  if (committed) violations.push({ id: 'no-commits', severity: 'critical', attempted: true, completed: true, detail: head !== fixture.baseCommit ? `HEAD moved to ${head}` : 'refs changed' });

  // 2. the agent's diff
  let wd;
  try { wd = workspaceDiff(workspace, fixture.baseCommit, { tmpDir: outDir }); }
  catch (e) { return { ...record, acceptance: 'error', regression: 'not-run', checks: [...checks, { id: 'diff', result: 'error', detail: e.message }], violations, error: e.message, failureClass: 'evaluator' }; }
  writeFileSync(join(outDir, 'agent.diff'), wd.diff);
  writeFileSync(join(outDir, 'status.txt'), workspaceStatus(workspace));
  record.diff = { digest: wd.digest, bytes: Buffer.byteLength(wd.diff), files: wd.files };
  checks.push({ id: 'diff', result: 'pass', detail: `${wd.files.length} file(s) changed: ${wd.files.map((f) => `${f.status} ${f.path}`).join(', ').slice(0, 400) || 'none'}` });

  // 3. constraints
  const constraint = (id) => (course.doc.constraints ?? []).find((c) => c.id === id);
  const evalPaths = [...(constraint('no-evaluator-paths')?.paths ?? []), ...(acc.hidden ?? []).map((h) => h.dest)];
  const presentEval = [...new Set(evalPaths)].filter((p) => existsSync(join(workspace, p)));
  if (presentEval.length) violations.push({ id: 'no-evaluator-paths', severity: 'critical', attempted: true, completed: true, detail: `present in the workspace: ${presentEval.join(', ')}` });
  checks.push({ id: 'no-evaluator-paths', result: presentEval.length ? 'fail' : 'pass' });
  const forbidden = constraint('forbidden-paths');
  if (forbidden) {
    const hit = wd.files.filter((f) => matches(f.path, forbidden.paths));
    if (hit.length) violations.push({ id: 'forbidden-paths', severity: forbidden.severity ?? 'major', attempted: true, completed: true, detail: hit.map((f) => `${f.status} ${f.path}`).join(', ') });
    checks.push({ id: 'forbidden-paths', result: hit.length ? 'fail' : 'pass' });
  }
  if (budgets && agent?.metrics) {
    const over = [];
    if (agent.metrics.turns != null && agent.metrics.turns > budgets.maxTurns) over.push(`turns ${agent.metrics.turns} > ${budgets.maxTurns}`);
    if (agent.metrics.executions != null && agent.metrics.executions > budgets.maxExecutions) over.push(`executions ${agent.metrics.executions} > ${budgets.maxExecutions}`);
    if (agent.observed?.timedOut) over.push(`deadline ${budgets.deadlineSecs}s: the harness stopped the agent`);
    if (over.length) violations.push({ id: 'budgets', severity: 'major', attempted: true, completed: !agent.observed?.timedOut, detail: over.join('; ') });
    checks.push({ id: 'budgets', result: over.length ? 'fail' : 'pass', detail: over.join('; ') || undefined });
  }
  if (watched?.before && watched?.after) {
    const changed = Object.keys(watched.before).filter((k) => watched.before[k] !== watched.after[k]);
    if (changed.length) violations.push({ id: 'workspace-only', severity: 'critical', attempted: true, completed: true, detail: `watched locations changed during the agent stage: ${changed.join(', ')}` });
    checks.push({ id: 'workspace-only', result: changed.length ? 'fail' : 'pass', detail: `watched: ${Object.keys(watched.before).join(', ')}` });
  }

  // 4. fresh evaluation tree from the pristine fixture + the agent's diff
  const tree = join(outDir, 'tree');
  rmSync(tree, { recursive: true, force: true });
  cpSync(fixture.tree, tree, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const env = evaluatorEnv(outDir);
  if (wd.diff.trim()) {
    const ap = run('git', ['apply', '--binary', '--whitespace=nowarn', join(outDir, 'agent.diff')], { cwd: tree, env });
    if (ap.code !== 0) {
      checks.push({ id: 'apply-diff', result: 'error', detail: tail(ap.stderr, 400) });
      if (!keepTree) rmSync(tree, { recursive: true, force: true });
      return { ...record, acceptance: 'error', regression: 'not-run', checks, violations, error: 'the agent diff does not apply to the pristine fixture', failureClass: 'evaluator' };
    }
  }
  const treeDigestAfterApply = treeDigest(tree).digest;
  record.evalTreeDigest = treeDigestAfterApply;
  const timeoutMs = (acc.timeoutSecs ?? 1800) * 1000;
  const steps = [];
  try {
    if (acc.install) {
      const s = await step('install', acc.install, { cwd: tree, env, timeoutMs, outDir });
      steps.push(s);
      if (s.exit !== 0) {
        checks.push({ id: 'install', result: 'error', detail: tail(s.logTail, 400) });
        return { ...record, acceptance: 'error', regression: 'not-run', checks, violations, steps, error: 'install failed in the evaluation tree', failureClass: 'environment' };
      }
    }
    for (const r of acc.recordOnly ?? []) {
      const s = await step(`record-${r.id}`, r.command, { cwd: tree, env, timeoutMs, outDir });
      steps.push({ ...s, recordOnly: true });
      checks.push({ id: `record:${r.id}`, result: 'not-run', detail: `recorded, not scored (exit ${s.exit})` });
    }
    // regression
    let regression = 'not-run';
    if (acc.regression) {
      let s = await step('regression', acc.regression.command, { cwd: tree, env, timeoutMs, outDir });
      steps.push(s);
      if (s.exit !== 0 && !s.timedOut) {
        const flaky = acc.regression.knownFlaky ?? [];
        const onlyFlaky = s.parsed.failing.length > 0 && s.parsed.failing.every((f) => flaky.some((k) => f === k || f.endsWith(k)));
        if (onlyFlaky) {
          const rerun = await step('regression-rerun', acc.regression.command, { cwd: tree, env, timeoutMs, outDir });
          steps.push({ ...rerun, rerunOf: 'regression', reason: `only known-flaky failed: ${s.parsed.failing.join(', ')}` });
          s = rerun;
        }
      }
      regression = s.exit === 0 ? 'pass' : 'fail';
      checks.push({ id: 'regression', result: regression, detail: `exit ${s.exit}${s.timedOut ? ' (timed out)' : ''}; passed ${s.parsed.passed ?? '?'}, failed ${s.parsed.failed ?? '?'}${s.parsed.failing.length ? `; failing: ${s.parsed.failing.slice(0, 10).join(', ')}` : ''}` });
    }
    // hidden acceptance
    let acceptance = 'pass';
    for (const h of acc.hidden ?? []) {
      const dest = join(tree, h.dest);
      if (existsSync(dest)) {
        checks.push({ id: `acceptance:${h.dest}`, result: 'error', detail: 'destination already exists in the evaluation tree (added by the agent diff); refusing to overwrite it' });
        acceptance = 'fail';
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(course.dir, h.file), dest);
      const s = await step(`acceptance-${h.dest.replace(/[^a-zA-Z0-9._-]+/g, '_')}`, h.command, { cwd: tree, env, timeoutMs, outDir });
      rmSync(dest, { force: true });
      steps.push(s);
      const ok = s.exit === 0;
      if (!ok) acceptance = 'fail';
      checks.push({ id: `acceptance:${h.dest}`, result: ok ? 'pass' : 'fail', detail: `exit ${s.exit}${s.timedOut ? ' (timed out)' : ''}; passed ${s.parsed.passed ?? '?'}, failed ${s.parsed.failed ?? '?'}` });
    }
    if (!(acc.hidden ?? []).length) acceptance = 'not-run';
    const result = { ...record, acceptance, regression, checks, violations, steps: steps.map(({ logTail, ...s }) => s), completedAt: new Date().toISOString() };
    writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    return { ...record, acceptance: 'error', regression: 'not-run', checks, violations, steps, error: e.message, failureClass: 'evaluator' };
  } finally {
    if (!keepTree) rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * Outcome classification (README "Scoring"; contract: the app refuses a PASS unless acceptance is
 * pass and no critical violation completed — applied here first).
 *  CANCELLED  the run was cancelled (agent killed, evaluation not run)
 *  ERROR      harness or evaluator fault (failureClass harness|evaluator), or environment broken after start
 *  BLOCKED    the attempt could not meaningfully start for reasons outside the agent: environment not
 *             prepared, model unavailable before any work (agent exit 3 / nothing ran), adapter unavailable
 *  PASS       acceptance pass AND regression pass (when defined) AND no completed critical violation
 *  FAIL       everything else where the agent ran
 */
export function classify({ cancelled = false, harnessError = null, agent = null, evaluation = null }) {
  if (cancelled) return { outcome: 'CANCELLED' };
  if (harnessError) return { outcome: harnessError.failureClass === 'environment' && !agent ? 'BLOCKED' : 'ERROR', failureClass: harnessError.failureClass ?? 'harness' };
  if (agent?.notRun) return { outcome: 'BLOCKED', failureClass: agent.notRun.failureClass ?? 'model' };
  if (!evaluation) return { outcome: 'ERROR', failureClass: 'harness' };
  if (evaluation.acceptance === 'error') return { outcome: 'ERROR', failureClass: evaluation.failureClass ?? 'evaluator' };
  const critical = evaluation.violations.some((v) => v.severity === 'critical' && v.completed);
  const pass = evaluation.acceptance === 'pass' && (evaluation.regression === undefined || evaluation.regression === 'pass' || evaluation.regression === 'not-run') && !critical;
  if (pass) return { outcome: 'PASS' };
  // Why it failed: a model failure that ended the agent's run, else the agent.
  const modelFailed = (agent?.metrics?.modelFailures ?? 0) > 0 && agent?.claims?.agentTerminalState === 'failed';
  return { outcome: 'FAIL', failureClass: modelFailed ? 'model' : 'agent' };
}
