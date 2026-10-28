// Independent evaluator. It never consults the agent's claim for correctness: the claim is
// recorded separately (RunResult.claims) and the outcome comes only from what this module runs.
//
//  0. explicit evaluator resolution (course.evaluator): `declarative` → the acceptance.v1 spec in
//     the public course document, interpreted here (declarative.mjs); `private` → the course's
//     private evaluator directory, pinned by digest and RE-CHECKED now; `none`, missing or invalid →
//     acceptance "error" (outcome ERROR, failureClass evaluator). Never skipped silently. The course
//     document's digest is re-checked against the run's as well;
//  1. base check: HEAD and refs of the agent workspace vs the fixture (commits are a violation);
//  2. the agent's diff against the base (tracked + committed + new untracked, `.stack-agent/` excluded);
//  3. constraint checks: evaluator paths present, forbidden paths modified, budgets, files outside
//     the workspace (watched locations), commits;
//  4. a FRESH evaluation tree = pristine cached fixture + the agent's diff (so ignored files the agent
//     wrote — node_modules, target/, .stack-agent/ — cannot influence the evaluator);
//  5. acceptance: declarative checks, or (private) install, record-only commands, the regression
//     command (one rerun when only known-flaky files fail; both recorded), then the hidden acceptance
//     files copied in from the private evaluator directory and their commands run;
//  6. the acceptance result is its own record (acceptance.json, `acceptanceResult`); classification
//     (PASS / FAIL / BLOCKED / ERROR / CANCELLED + failureClass) reads only that record and harness
//     state — never the course's `scoring` section or any scorecard.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroup, run } from '../lib/proc.mjs';
import { sha256, tail, treeDigest, canonicalDigest } from '../lib/util.mjs';
import { workspaceDiff, workspaceStatus } from '../evidence/index.mjs';
import { gitHead, gitRefs } from '../courses/fixtures.mjs';
import { courseDigest, bareDigest } from '../courses/index.mjs';
import { validateEvaluatorDeclaration, validateCourseAcceptance, ACCEPTANCE_SCHEMA } from '../../feltkit/lib/acceptance-v1.js';
import { runDeclarative } from './declarative.mjs';
import { toolchainPath } from '../lib/paths.mjs';
import { parseTestOutput } from './parse.mjs';

export { parseTestOutput };
const HERE = dirname(fileURLToPath(import.meta.url));
export const ACCEPTANCE_RESULT_SCHEMA = 'aoc.acceptance-result.v1';

const SCHEMA_FILE = fileURLToPath(new URL('../../feltkit/lib/acceptance-v1.js', import.meta.url));

/** name@version+<12 hex of sha256 over this directory's files and the acceptance.v1 schema it interprets> */
export function evaluatorVersion() {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  const files = readdirSync(HERE).filter((f) => statSync(join(HERE, f)).isFile()).sort().map((f) => [f, join(HERE, f)]);
  files.push(['acceptance-v1.js', SCHEMA_FILE]);
  const digest = sha256(files.map(([f, p]) => `${f}\0${sha256(readFileSync(p))}`).join('\n'));
  return `${pkg.name}@${pkg.version}+${digest.slice(0, 12)}`;
}

export class EvaluatorError extends Error {
  constructor(message, reason) { super(message); this.failureClass = 'evaluator'; this.reason = reason; }
}

/** Digest of a private evaluator directory (every file, nothing excluded). */
export const privateEvaluatorDigest = (dir) => treeDigest(dir, { exclude: [] }).digest;

/**
 * Explicit evaluator resolution. Returns { kind, version, digest ("sha256:…"), interpreter,
 * acceptanceDigest, dir? } or throws EvaluatorError (reason: course-digest-mismatch |
 * evaluator-missing | evaluator-invalid | evaluator-digest-mismatch).
 */
export function resolveEvaluator(course, { expectedCourseDigest } = {}) {
  const doc = course.doc;
  if (expectedCourseDigest && bareDigest(courseDigest(doc)) !== bareDigest(expectedCourseDigest)) {
    throw new EvaluatorError(`course-digest-mismatch: the course document now has digest ${courseDigest(doc)}, the run was pinned to ${expectedCourseDigest}`, 'course-digest-mismatch');
  }
  const decl = validateEvaluatorDeclaration(doc);
  if (decl.length) throw new EvaluatorError(`evaluator-missing: ${decl.join('; ')}`, 'evaluator-missing');
  const ev = doc.evaluator;
  if (ev.kind === 'none') throw new EvaluatorError(`evaluator-missing: the course declares evaluator kind "none"${ev.reason ? ` (${ev.reason})` : ''}; nothing can accept a run`, 'evaluator-missing');
  const problems = validateCourseAcceptance(doc);
  if (problems.length) throw new EvaluatorError(`evaluator-invalid: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ''}`, 'evaluator-invalid');
  const acceptanceDigest = `sha256:${canonicalDigest(doc.acceptance)}`;
  const interpreter = evaluatorVersion();
  if (ev.kind === 'declarative') return { kind: 'declarative', version: ACCEPTANCE_SCHEMA, digest: acceptanceDigest, interpreter, acceptanceDigest };
  const dir = join(course.dir, ev.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new EvaluatorError(`evaluator-missing: the private evaluator directory ${ev.dir}/ does not exist`, 'evaluator-missing');
  const digest = privateEvaluatorDigest(dir);
  if (digest !== ev.digest) throw new EvaluatorError(`evaluator-digest-mismatch: the private evaluator directory has digest ${digest}, the course pins ${ev.digest} (changed or tampered with)`, 'evaluator-digest-mismatch');
  return { kind: 'private', version: ev.version, digest: `sha256:${digest}`, interpreter, acceptanceDigest, dir };
}

export function evaluatorEnv(evalDir) {
  return {
    PATH: toolchainPath(),
    HOME: process.env.HOME, LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0',
    RUSTUP_TOOLCHAIN: 'stable', CARGO_TARGET_DIR: join(evalDir, 'target'), CARGO_INCREMENTAL: '0', CARGO_TERM_COLOR: 'never',
    ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}), ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
  };
}

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const matches = (path, patterns) => patterns.some((p) => globToRe(p).test(path));

async function step(name, argv, { cwd, env, timeoutMs, outDir }) {
  const r = await runGroup(argv[0], argv.slice(1), { cwd, env, timeoutMs });
  const text = `$ ${argv.join(' ')}\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.timedOut ? ' (timed out)' : ''} in ${r.durationMs} ms\n`;
  writeFileSync(join(outDir, `${name}.log`), text);
  return { name, argv, exit: r.code, signal: r.signal, timedOut: r.timedOut, ms: r.durationMs, spawnError: r.error ?? null, logDigest: sha256(text), parsed: parseTestOutput(r.stdout + '\n' + r.stderr), logTail: tail(r.stdout + '\n' + r.stderr, 3000) };
}
const countsOf = (p) => (p.passed === null ? null : { passed: p.passed, failed: p.failed, skipped: p.skipped });

/**
 * @param {object} p
 * @param {{doc: object, dir: string}} p.course
 * @param {{tree: string, baseCommit: string, refs: string}} p.fixture   the pristine cached fixture
 * @param {string} p.workspace         the agent's final workspace
 * @param {string} p.outDir            evaluator output directory (created; the fresh tree goes in outDir/tree)
 * @param {object} [p.agent]           agent result (only budgets/observed facts are read; never the claim)
 * @param {object} [p.budgets]
 * @param {object} [p.watched]         { before: {label: digest}, after: {label: digest} }
 * @param {string} [p.expectedCourseDigest]  the run's pinned course digest (re-checked here)
 */
export async function evaluate({ course, fixture, workspace, outDir, agent = null, budgets = null, watched = null, keepTree = false, expectedCourseDigest = null }) {
  const version = evaluatorVersion();
  mkdirSync(outDir, { recursive: true });
  const checks = []; const violations = [];
  const record = { evaluatorVersion: version, startedAt: new Date().toISOString() };
  const fault = (message, failureClass = 'evaluator', extra = {}) => {
    const r = { ...record, acceptance: 'error', regression: 'not-run', checks, violations, error: message, failureClass, ...extra };
    r.acceptanceResult = acceptanceResult(r, []);
    writeFileSync(join(outDir, 'acceptance.json'), JSON.stringify(r.acceptanceResult, null, 2));
    return r;
  };

  // 0. explicit evaluator resolution (digests re-checked now, at evaluation)
  let ev;
  try { ev = resolveEvaluator(course, { expectedCourseDigest }); }
  catch (e) {
    checks.push({ id: 'evaluator', result: 'error', executed: false, detail: e.message });
    watchedCheck(watched, checks, violations);   // a write to the course or evaluator during the run is still a recorded violation
    return fault(e.message, 'evaluator', { evaluatorReason: e.reason ?? 'evaluator-invalid' });
  }
  record.evaluator = { kind: ev.kind, version: ev.version, digest: ev.digest, interpreter: ev.interpreter };
  record.acceptanceDigest = ev.acceptanceDigest;
  checks.push({ id: 'evaluator', result: 'pass', executed: true, detail: `${ev.kind} ${ev.version} ${ev.digest.slice(0, 19)}…` });
  const acc = course.doc.acceptance;

  // 1. base check
  const head = gitHead(workspace);
  const refs = gitRefs(workspace);
  const committed = head !== fixture.baseCommit || refs !== fixture.refs;
  checks.push({ id: 'base-commit', result: head === fixture.baseCommit ? 'pass' : 'fail', executed: true, detail: `HEAD ${head.slice(0, 12)} (base ${fixture.baseCommit.slice(0, 12)})` });
  if (committed) violations.push({ id: 'no-commits', severity: 'critical', attempted: true, completed: true, detail: head !== fixture.baseCommit ? `HEAD moved to ${head}` : 'refs changed' });

  // 2. the agent's diff
  let wd;
  try { wd = workspaceDiff(workspace, fixture.baseCommit, { tmpDir: outDir }); }
  catch (e) { checks.push({ id: 'diff', result: 'error', executed: false, detail: e.message }); return fault(e.message); }
  writeFileSync(join(outDir, 'agent.diff'), wd.diff);
  writeFileSync(join(outDir, 'status.txt'), workspaceStatus(workspace));
  record.diff = { digest: wd.digest, bytes: Buffer.byteLength(wd.diff), files: wd.files };
  checks.push({ id: 'diff', result: 'pass', executed: true, detail: `${wd.files.length} file(s) changed: ${wd.files.map((f) => `${f.status} ${f.path}`).join(', ').slice(0, 400) || 'none'}` });

  // 3. constraints
  const constraint = (id) => (course.doc.constraints ?? []).find((c) => c.id === id);
  const hidden = ev.kind === 'private' ? acc.hidden ?? [] : [];
  const evalPaths = [...(constraint('no-evaluator-paths')?.paths ?? []), ...hidden.map((h) => h.dest)];
  if (evalPaths.length) {
    const presentEval = [...new Set(evalPaths)].filter((p) => existsSync(join(workspace, p)));
    if (presentEval.length) violations.push({ id: 'no-evaluator-paths', severity: 'critical', attempted: true, completed: true, detail: `present in the workspace: ${presentEval.join(', ')}` });
    checks.push({ id: 'no-evaluator-paths', result: presentEval.length ? 'fail' : 'pass', executed: true });
  }
  const forbidden = constraint('forbidden-paths');
  if (forbidden) {
    const hit = wd.files.filter((f) => matches(f.path, forbidden.paths));
    if (hit.length) violations.push({ id: 'forbidden-paths', severity: forbidden.severity ?? 'major', attempted: true, completed: true, detail: hit.map((f) => `${f.status} ${f.path}`).join(', ') });
    checks.push({ id: 'forbidden-paths', result: hit.length ? 'fail' : 'pass', executed: true });
  }
  if (budgets && agent?.metrics) {
    const over = [];
    if (agent.metrics.turns != null && agent.metrics.turns > budgets.maxTurns) over.push(`turns ${agent.metrics.turns} > ${budgets.maxTurns}`);
    if (agent.metrics.executions != null && agent.metrics.executions > budgets.maxExecutions) over.push(`executions ${agent.metrics.executions} > ${budgets.maxExecutions}`);
    if (agent.observed?.timedOut) over.push(`deadline ${budgets.deadlineSecs}s: the harness stopped the agent`);
    if (over.length) violations.push({ id: 'budgets', severity: 'major', attempted: true, completed: !agent.observed?.timedOut, detail: over.join('; ') });
    checks.push({ id: 'budgets', result: over.length ? 'fail' : 'pass', executed: true, detail: over.join('; ') || undefined });
  }
  watchedCheck(watched, checks, violations);

  // 4. fresh evaluation tree from the pristine fixture + the agent's diff
  const tree = join(outDir, 'tree');
  rmSync(tree, { recursive: true, force: true });
  cpSync(fixture.tree, tree, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const env = evaluatorEnv(outDir);
  try {
    if (wd.diff.trim()) {
      const ap = run('git', ['apply', '--binary', '--whitespace=nowarn', join(outDir, 'agent.diff')], { cwd: tree, env });
      if (ap.code !== 0) {
        checks.push({ id: 'apply-diff', result: 'error', executed: true, detail: tail(ap.stderr, 400) });
        return fault('the agent diff does not apply to the pristine fixture');
      }
    }
    record.evalTreeDigest = treeDigest(tree).digest;
    // 5. acceptance
    const out = ev.kind === 'declarative'
      ? await declarativeAcceptance({ course, ev, tree, fixture, workspace, env, outDir, checks })
      : await privateAcceptance({ course, ev, acc, tree, env, outDir, checks });
    const result = { ...record, ...out, checks, violations, completedAt: new Date().toISOString() };
    result.acceptanceResult = acceptanceResult(result, out.records ?? []);
    delete result.records;
    writeFileSync(join(outDir, 'acceptance.json'), JSON.stringify(result.acceptanceResult, null, 2));
    writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    return fault(e.message);
  } finally {
    if (!keepTree) rmSync(tree, { recursive: true, force: true });
  }
}

/** Locations digested before and after the agent stage (fixture cache, course directory, evaluator code). */
function watchedCheck(watched, checks, violations) {
  if (!watched?.before || !watched?.after) return;
  const changed = Object.keys(watched.before).filter((k) => watched.before[k] !== watched.after[k]);
  if (changed.length) violations.push({ id: 'workspace-only', severity: 'critical', attempted: true, completed: true, detail: `watched locations changed during the agent stage: ${changed.join(', ')}` });
  checks.push({ id: 'workspace-only', result: changed.length ? 'fail' : 'pass', executed: true, detail: `watched: ${Object.keys(watched.before).join(', ')}` });
}

async function declarativeAcceptance({ course, tree, fixture, workspace, env, outDir, checks }) {
  const r = await runDeclarative({ spec: course.doc.acceptance, ecosystem: course.doc.environment?.ecosystem ?? null, tree, fixture, workspace, env, outDir });
  for (const rec of r.records) checks.push({ id: `acceptance:${rec.id}`, result: rec.result, executed: rec.executed, kind: rec.kind, ...(rec.detail ? { detail: rec.detail } : {}), ...(rec.observed?.counts ? { counts: rec.observed.counts } : {}) });
  return {
    acceptance: r.result, steps: r.steps.map((s) => ({ ...s, public: true })), setup: r.setup, records: r.records,
    ...(r.error ? { error: r.error, failureClass: r.failureClass } : {}),
  };
}

async function privateAcceptance({ course, ev, acc, tree, env, outDir, checks }) {
  const timeoutMs = (acc.timeoutSecs ?? 1800) * 1000;
  const steps = [];
  const strip = ({ logTail, parsed, ...s }) => s;
  if (acc.install) {
    const s = await step('install', acc.install, { cwd: tree, env, timeoutMs, outDir });
    steps.push(strip(s));
    if (s.exit !== 0) {
      checks.push({ id: 'install', result: 'error', executed: true, detail: tail(s.logTail, 400) });
      return { acceptance: 'error', regression: 'not-run', steps, error: 'install failed in the evaluation tree', failureClass: 'environment' };
    }
  }
  for (const r of acc.recordOnly ?? []) {
    const s = await step(`record-${r.id}`, r.command, { cwd: tree, env, timeoutMs, outDir });
    steps.push({ ...strip(s), recordOnly: true });
    checks.push({ id: `record:${r.id}`, result: 'not-run', executed: true, detail: `recorded, not scored (exit ${s.exit})` });
  }
  // regression (public tests of the fixture)
  let regression = 'not-run';
  if (acc.regression) {
    let s = await step('regression', acc.regression.command, { cwd: tree, env, timeoutMs, outDir });
    steps.push(strip(s));
    if (s.exit !== 0 && !s.timedOut) {
      const flaky = acc.regression.knownFlaky ?? [];
      const onlyFlaky = s.parsed.failing.length > 0 && s.parsed.failing.every((f) => flaky.some((k) => f === k || f.endsWith(k)));
      if (onlyFlaky) {
        const rerun = await step('regression-rerun', acc.regression.command, { cwd: tree, env, timeoutMs, outDir });
        steps.push({ ...strip(rerun), rerunOf: 'regression', reason: `only known-flaky failed: ${s.parsed.failing.join(', ')}` });
        s = rerun;
      }
    }
    const executed = s.exit !== null || s.timedOut;
    regression = !executed ? 'not-run' : s.exit === 0 ? 'pass' : 'fail';
    checks.push({ id: 'regression', result: executed ? regression : 'error', executed, counts: countsOf(s.parsed), detail: `exit ${s.exit}${s.timedOut ? ' (timed out)' : ''}; passed ${s.parsed.passed ?? '?'}, failed ${s.parsed.failed ?? '?'}${s.parsed.failing.length ? `; failing: ${s.parsed.failing.slice(0, 10).join(', ')}` : ''}` });
  }
  if (acc.regression && regression === 'not-run') return { acceptance: 'error', regression, steps, error: `the regression command could not be run (${acc.regression.command[0]})`, failureClass: 'evaluator' };
  // hidden acceptance: copied in from the private evaluator directory, run, removed. Its output
  // (test names) stays on the harness host: only exit and counts leave this function.
  let acceptance = 'pass';
  let errored = false;
  for (const h of acc.hidden) {
    const id = `acceptance:${h.dest}`;
    const dest = join(tree, h.dest);
    if (existsSync(dest)) {
      checks.push({ id, result: 'error', executed: false, detail: 'destination already exists in the evaluation tree (added by the agent diff); refusing to overwrite it' });
      acceptance = 'fail';
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(course.dir, h.file), dest);
    const s = await step(`acceptance-${h.dest.replace(/[^a-zA-Z0-9._-]+/g, '_')}`, h.command, { cwd: tree, env, timeoutMs, outDir });
    rmSync(dest, { force: true });
    steps.push({ ...strip(s), hidden: true });
    const executed = s.exit !== null || s.timedOut;
    if (!executed) { errored = true; checks.push({ id, result: 'error', executed: false, detail: `could not run ${h.command[0]}: ${s.spawnError ?? s.signal}` }); continue; }
    const ok = s.exit === 0;
    if (!ok) acceptance = 'fail';
    checks.push({ id, result: ok ? 'pass' : 'fail', executed: true, counts: countsOf(s.parsed), detail: `exit ${s.exit}${s.timedOut ? ' (timed out)' : ''}; passed ${s.parsed.passed ?? '?'}, failed ${s.parsed.failed ?? '?'}` });
  }
  if (errored && acceptance === 'pass') return { acceptance: 'error', regression, steps, error: 'a hidden acceptance command could not be run', failureClass: 'evaluator' };
  // the private evaluator's acceptance needs its regression too (PASS needs both)
  return { acceptance, regression, steps };
}

/** The acceptance result as its own record (no scoring; nothing the agent claimed). */
function acceptanceResult(r, records) {
  const scored = (r.checks ?? []).filter((c) => c.id.startsWith('acceptance:') || c.id === 'regression');
  return {
    schema: ACCEPTANCE_RESULT_SCHEMA, result: r.acceptance, ...(r.regression !== undefined ? { regression: r.regression } : {}),
    evaluator: r.evaluator ?? null, acceptanceDigest: r.acceptanceDigest ?? null, evaluatorVersion: r.evaluatorVersion,
    executed: scored.filter((c) => c.executed).length, total: scored.length,
    checks: records.length ? records.map(({ observed, ...x }) => ({ ...x, ...(observed ? { observed: { exit: observed.exit, timedOut: observed.timedOut, ms: observed.ms, counts: observed.counts ?? null } } : {}) }))
      : scored.map((c) => ({ id: c.id, result: c.result, executed: !!c.executed, ...(c.counts ? { counts: c.counts } : {}) })),
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * Outcome classification (README "Scoring"; contract: the app refuses a PASS unless acceptance is
 * pass and no critical violation completed — applied here first). Inputs are the acceptance record
 * and harness state ONLY: the course's `scoring` section and any scorecard are never read, so no
 * score can turn a failed acceptance into a PASS.
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
  if (!['pass', 'fail', 'not-run'].includes(evaluation.acceptance)) return { outcome: 'ERROR', failureClass: 'evaluator' };
  const critical = evaluation.violations.some((v) => v.severity === 'critical' && v.completed);
  const pass = evaluation.acceptance === 'pass' && (evaluation.regression === undefined || evaluation.regression === 'pass' || evaluation.regression === 'not-run') && !critical;
  if (pass) return { outcome: 'PASS' };
  // Why it failed: a model failure that ended the agent's run, else the agent.
  const modelFailed = (agent?.metrics?.modelFailures ?? 0) > 0 && agent?.claims?.agentTerminalState === 'failed';
  return { outcome: 'FAIL', failureClass: modelFailed ? 'model' : 'agent' };
}
