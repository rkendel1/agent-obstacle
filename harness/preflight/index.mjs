// Preflight: the release gate of a course version (npm run courses:preflight -- <course>/<version>).
//
// It runs the real stage pipeline (runDirect) twice — the unchanged fixture (null-control) and the
// course's reference fix (reference-control) — and checks, as named gates:
//   evaluator-resolved    the explicit evaluator declaration resolves (none / missing / invalid fail)
//   course-valid          structure, pins, approved commands, no private content in the document
//   fixture-reproducible  prepared twice (cache + an independent copy) -> the same digest and base, = the pin
//   baseline-fails        the unchanged fixture FAILS: acceptance fail, every declared mustFail check
//                         fails, every mustPass passes, declared counts match exactly
//   reference-passes      the reference PASSES: every acceptance check passes, declared counts match
//   checks-executed       every acceptance check of both runs executed; none passed without running
//   evidence-captured     the evidence the course requires (and the harness's own) was captured
//   evaluator-isolated    no private file is in, under, or copied into a workspace; the agent stage
//                         watched the course directory and the evaluator code; the report leaks nothing
//   tamper-detected       a changed private evaluator / acceptance makes evaluation ERROR (digests re-checked)
//   cleanup               evaluation copies deleted, the fixture cache unchanged, preflight scratch removed
// The report (aoc.preflight.v1) carries only ids, results, counts and digests — never evaluator
// source, hidden test output or the reference fix — and is stored with the course version
// (courses/<id>/<version>/preflight.json; the app requires a passing one to publish).
import { mkdirSync, mkdtempSync, rmSync, existsSync, cpSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { stateDir, TOOLS } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { nowIso, readJSON, readJSONL, sha256File, treeDigest, bounded } from '../lib/util.mjs';
import { validateCourse, privateFiles, leakedFiles, loadCourseDir } from '../courses/index.mjs';
import { prepareFixture, createWorkspace } from '../courses/fixtures.mjs';
import { resolveEvaluator, evaluate, classify, evaluatorVersion } from '../evaluator/index.mjs';
import { leafChecks } from '../../feltkit/lib/acceptance-v1.js';
import { runDirect } from '../worker/direct.mjs';
import { experimentDigest } from '../worker/stages.mjs';

export const PREFLIGHT_SCHEMA = 'aoc.preflight.v1';
export const GATES = ['evaluator-resolved', 'course-valid', 'fixture-reproducible', 'baseline-fails', 'reference-passes', 'checks-executed', 'evidence-captured', 'evaluator-isolated', 'tamper-detected', 'cleanup'];
/** Evidence the harness captures for every run, whatever the course says. */
export const HARNESS_EVIDENCE = ['digest:prepare', 'pax.observation:before', 'process:agent', 'pax.observation:after', 'diff:agent', 'digest:final', 'acceptance:verdict', 'acceptance:result', 'log:run-result'];
/** Evidence only an agent produces (a control has none): not applicable to a preflight. */
const AGENT_PRODUCED = ['agent.report', 'pax.test'];

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

function controlInput(course, adapter) {
  const experiment = { experimentId: `preflight-${adapter}`, agent: { adapter, options: {} }, model: null, budgets: { maxTurns: 1, maxExecutions: 1, deadlineSecs: 600, callTimeoutSecs: 60 }, obstacles: { enabled: false }, environment: { kind: 'local-isolated' } };
  experiment.digest = experimentDigest(experiment);
  return { courseVersionId: `${course.id}@${course.version}`, courseDigest: course.digest, experiment, requestedAt: nowIso(), requestedBy: 'preflight' };
}

/** Ids → records of the acceptance result (raw ids for acceptance.v1; RunResult ids for a private evaluator). */
function acceptanceChecks(runDir) {
  const ar = readJSON(join(runDir, 'eval', 'acceptance.json'), null);
  return { ar, byId: new Map((ar?.checks ?? []).map((c) => [c.id, c])) };
}
const countsOf = (c) => c?.observed?.counts ?? c?.counts ?? null;
const summary = (c) => ({ id: c.id, result: c.result, executed: !!c.executed, ...(countsOf(c) ? { counts: countsOf(c) } : {}) });

function expectations(rs, byId, { mustFail = [], mustPass = [], counts = {} }) {
  const misses = [];
  for (const id of mustFail) { const c = byId.get(id); if (!c || c.result !== 'fail' || !c.executed) misses.push(`${id} must fail at the baseline (got ${c ? `${c.result}${c.executed ? '' : ', not executed'}` : 'no record'})`); }
  for (const id of mustPass) { const c = byId.get(id); if (!c || c.result !== 'pass' || !c.executed) misses.push(`${id} must pass (got ${c ? c.result : 'no record'})`); }
  for (const [id, want] of Object.entries(counts)) {
    const got = countsOf(byId.get(id));
    for (const k of Object.keys(want)) if (!got || got[k] !== want[k]) misses.push(`${id}: ${k} ${got ? got[k] : 'not observed'}, expected ${want[k]}`);
  }
  return misses;
}

/** Files under `root` (no .git, node_modules, target, .stack-agent) with their sha256, relative paths. */
function fileDigests(root) {
  const out = new Map();
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (['.git', 'node_modules', 'target', '.stack-agent'].includes(n)) continue;
      const p = join(d, n); const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else if (st.isFile()) out.set(relative(root, p), sha256File(p));
    }
  };
  walk(root);
  return out;
}

/**
 * Run the preflight of one course version. Returns the report (aoc.preflight.v1).
 * @param {object} course   loadCourseDir() result; its directory must sit at <root>/<id>/<version>
 */
export async function preflight(course, { log = () => {}, workRoot = join(stateDir(), 'preflight'), adapters } = {}) {
  const startedAt = nowIso();
  mkdirSync(workRoot, { recursive: true });
  const work = mkdtempSync(join(workRoot, `${course.id}-${course.version}-`));
  const gates = new Map(GATES.map((g) => [g, { id: g, result: 'not-run' }]));
  const set = (id, ok, evidence, detail) => { gates.set(id, { id, result: ok ? 'pass' : 'fail', ...(detail ? { detail: bounded(detail, 1500) } : {}), evidence }); log(`${ok ? 'pass' : 'FAIL'} ${id}${detail ? `: ${detail}` : ''}`); };
  const runs = {};
  let ev = null; let error = null; let fixtureA = null;
  try {
    // evaluator-resolved, course-valid
    try { ev = resolveEvaluator(course); set('evaluator-resolved', true, { kind: ev.kind, version: ev.version, digest: ev.digest }); }
    catch (e) { set('evaluator-resolved', false, { kind: course.doc.evaluator?.kind ?? null, reason: e.reason ?? null }, e.message); throw Object.assign(new Error('the evaluator does not resolve'), { stop: true }); }
    const problems = validateCourse(course);
    set('course-valid', !problems.length, { problems: problems.slice(0, 20) }, problems.length ? problems.join('; ') : null);
    if (problems.length) throw Object.assign(new Error('the course is not valid'), { stop: true });

    // fixture-reproducible
    fixtureA = prepareFixture(course, { log });
    const fixtureB = prepareFixture(course, { log, root: join(work, 'fixture-b') });
    const pin = course.doc.environment.fixture.digest;
    const same = fixtureA.fixtureDigest === fixtureB.fixtureDigest && fixtureA.baseCommit === fixtureB.baseCommit;
    set('fixture-reproducible', same && fixtureA.fixtureDigest === pin && !fixtureB.cached,
      { pinned: pin, first: fixtureA.fixtureDigest, second: fixtureB.fixtureDigest, baseCommit: fixtureA.baseCommit, secondBaseCommit: fixtureB.baseCommit, firstFromCache: fixtureA.cached },
      !same ? 'two preparations differ' : fixtureA.fixtureDigest !== pin ? 'the prepared fixture does not match the pin' : null);
    rmSync(join(work, 'fixture-b'), { recursive: true, force: true });

    // the two control runs, through the real stage pipeline
    const coursesRoot = dirname(dirname(course.dir));
    for (const [name, adapter] of [['baseline', 'null-control'], ['reference', 'reference-control']]) {
      const runId = `preflight-${name}`;
      log(`${name}: ${adapter} through the stage pipeline`);
      const r = await runDirect({ runId, input: { runId, ...controlInput(course, adapter) }, runsRoot: join(work, 'runs'), coursesRoot, adapters, log: () => {} });
      const { ar, byId } = acceptanceChecks(r.runDir);
      runs[name] = { runDir: r.runDir, result: r.result, ar, byId };
    }
    const acc = course.doc.acceptance;
    const pf = acc.preflight;
    const view = (x) => ({ outcome: x.result?.outcome ?? null, failureClass: x.result?.failureClass ?? null, acceptance: x.result?.evaluation?.acceptance ?? null, ...(x.result?.evaluation?.regression !== undefined ? { regression: x.result.evaluation.regression } : {}), checks: [...x.byId.values()].map(summary) });

    // baseline-fails
    const b = runs.baseline;
    const bMiss = expectations(b.result, b.byId, pf.baseline);
    if (b.result?.outcome !== 'FAIL') bMiss.unshift(`outcome ${b.result?.outcome ?? 'none'} (expected FAIL)`);
    if (b.result?.evaluation?.acceptance !== 'fail') bMiss.unshift(`acceptance ${b.result?.evaluation?.acceptance ?? 'none'} (expected fail)`);
    set('baseline-fails', !bMiss.length, { ...view(b), expected: pf.baseline, misses: bMiss }, bMiss.join('; ') || null);

    // reference-passes
    const rf = runs.reference;
    const rMiss = expectations(rf.result, rf.byId, { mustPass: [...rf.byId.keys()], counts: pf.reference?.counts ?? {} });
    if (rf.result?.outcome !== 'PASS') rMiss.unshift(`outcome ${rf.result?.outcome ?? 'none'}${rf.result?.failureClass ? ` (${rf.result.failureClass})` : ''} (expected PASS)`);
    if (ev.kind === 'private' && acc.regression && rf.result?.evaluation?.regression !== 'pass') rMiss.push(`regression ${rf.result?.evaluation?.regression} (expected pass)`);
    set('reference-passes', !rMiss.length, { ...view(rf), expected: pf.reference ?? {}, misses: rMiss }, rMiss.join('; ') || null);

    // checks-executed: every check executed; nothing passed without running; nothing missing
    const expectedIds = ev.kind === 'declarative' ? leafChecks(acc).map((c) => c.id).concat([acc.require.id]) : [...(acc.regression ? ['regression'] : []), ...acc.hidden.map((h) => `acceptance:${h.dest}`)];
    const eMiss = [];
    for (const [name, x] of Object.entries(runs)) {
      if (!x.ar) { eMiss.push(`${name}: no acceptance record`); continue; }
      for (const id of expectedIds) if (!x.byId.has(id)) eMiss.push(`${name}: ${id} has no record`);
      for (const c of x.byId.values()) {
        if (!c.executed) eMiss.push(`${name}: ${c.id} did not execute (${c.result})`);
        if (c.result === 'pass' && !c.executed) eMiss.push(`${name}: ${c.id} reports pass without having run`);
      }
      if (x.ar.executed !== x.ar.total) eMiss.push(`${name}: ${x.ar.executed}/${x.ar.total} scored checks executed`);
    }
    set('checks-executed', !eMiss.length, { expected: expectedIds.length, baseline: { executed: b.ar?.executed, total: b.ar?.total }, reference: { executed: rf.ar?.executed, total: rf.ar?.total }, misses: eMiss }, eMiss.join('; ') || null);

    // evidence-captured (reference run)
    const items = readJSONL(join(rf.runDir, 'evidence.jsonl'));
    const ids = new Set(items.map((i) => i.evidenceId)); const kinds = new Set(items.map((i) => i.kind));
    const required = (course.doc.evidence?.required ?? []).map((s) => String(s).split(' ')[0]);
    const captured = []; const notApplicable = []; const missing = [];
    for (const r of [...new Set([...HARNESS_EVIDENCE, ...required])]) {
      const have = ids.has(r) || kinds.has(r) || [...ids].some((i) => i.startsWith(`${r}:`));
      if (have) captured.push(r); else if (AGENT_PRODUCED.includes(r)) notApplicable.push(r); else missing.push(r);
    }
    set('evidence-captured', !missing.length, { captured, notApplicable: notApplicable.map((r) => `${r} (produced only by an agent; a control has none)`), missing }, missing.length ? `missing: ${missing.join(', ')}` : null);

    // evaluator-isolated
    const priv = privateFiles(course);
    const privDigests = new Map(priv.map((f) => [sha256File(f), relative(course.dir, f)]));
    const iMiss = [];
    for (const f of priv) for (const [label, d] of [['fixture cache', fixtureA.tree], ['baseline workspace', join(b.runDir, 'workspace')], ['reference workspace', join(rf.runDir, 'workspace')]]) if (inside(f, d)) iMiss.push(`${relative(course.dir, f)} is inside the ${label}`);
    let scanned = 0;
    for (const [label, d] of [['fixture cache', fixtureA.tree], ['baseline workspace', join(b.runDir, 'workspace')]]) {
      for (const [p, digest] of fileDigests(d)) { scanned++; if (privDigests.has(digest)) iMiss.push(`${label} holds a copy of ${privDigests.get(digest)} at ${p}`); }
    }
    for (const h of ev.kind === 'private' ? acc.hidden : []) if (existsSync(join(b.runDir, 'workspace', h.dest))) iMiss.push(`hidden destination ${h.dest} exists in the baseline workspace`);
    const watched = Object.keys(readJSON(join(rf.runDir, 'checkpoints.json'), {})?.agent?.watched?.before ?? {});
    for (const k of ['course', 'evaluatorCode']) if (!watched.includes(k)) iMiss.push(`the agent stage did not watch ${k}`);
    set('evaluator-isolated', !iMiss.length, { privateFiles: priv.map((f) => relative(course.dir, f)), filesScanned: scanned, watched, misses: iMiss, note: 'detected, not prevented: the agent runs as the same OS user; a write to the course directory or evaluator code is a critical violation and a changed private evaluator ERRORs at evaluation' }, iMiss.join('; ') || null);

    // tamper-detected: a changed private evaluator, or a changed acceptance, must make evaluation ERROR
    const tdir = join(work, 'tamper', course.id, course.version);
    cpSync(course.dir, tdir, { recursive: true });
    let what;
    if (ev.kind === 'private') {
      const target = join(tdir, acc.hidden[0].file);
      writeFileSync(target, readFileSync(target, 'utf8') + '\n// tampered\n');
      what = `appended to ${acc.hidden[0].file}`;
    } else {
      const doc = JSON.parse(readFileSync(join(tdir, 'course.json'), 'utf8'));
      doc.acceptance.require.kind = doc.acceptance.require.kind === 'all' ? 'any' : 'all';
      writeFileSync(join(tdir, 'course.json'), JSON.stringify(doc, null, 2));
      what = 'flipped acceptance.require all/any in course.json';
    }
    const tws = join(work, 'tamper-ws');
    createWorkspace(fixtureA, tws);
    const te = await evaluate({ course: loadCourseDir(tdir), fixture: fixtureA, workspace: tws, outDir: join(work, 'tamper-eval'), expectedCourseDigest: course.digest });
    const tc = classify({ agent: { metrics: {} }, evaluation: te });
    set('tamper-detected', te.acceptance === 'error' && tc.outcome === 'ERROR' && tc.failureClass === 'evaluator', { tampered: what, acceptance: te.acceptance, outcome: tc.outcome, failureClass: tc.failureClass ?? null, reason: te.evaluatorReason ?? null }, te.acceptance === 'error' ? null : `tampering was not detected (acceptance ${te.acceptance})`);
  } catch (e) {
    if (!e.stop) { error = e.message; log(`preflight error: ${e.stack ?? e.message}`); }
  }

  // cleanup
  try {
    const cMiss = [];
    for (const [name, x] of Object.entries(runs)) if (existsSync(join(x.runDir, 'eval', 'tree'))) cMiss.push(`${name}: the evaluation copy was not deleted`);
    if (fixtureA && treeDigest(fixtureA.tree).digest !== course.doc.environment.fixture.digest) cMiss.push('the fixture cache changed during preflight');
    rmSync(work, { recursive: true, force: true });
    if (existsSync(work)) cMiss.push('preflight scratch could not be removed');
    if (Object.keys(runs).length === 2 || cMiss.length) set('cleanup', !cMiss.length, { evaluationCopies: Object.keys(runs).length, fixtureCacheIntact: !cMiss.some((m) => m.includes('fixture')), scratchRemoved: !existsSync(work), misses: cMiss }, cMiss.join('; ') || null);
  } catch (e) { set('cleanup', false, {}, e.message); }

  const report = {
    schema: PREFLIGHT_SCHEMA,
    course: { id: course.id, version: course.version, digest: course.digest },
    evaluator: ev ? { kind: ev.kind, version: ev.version, digest: ev.digest } : { kind: course.doc.evaluator?.kind ?? null },
    acceptanceDigest: ev?.acceptanceDigest ?? null,
    harness: { evaluatorVersion: evaluatorVersion(), paxVersion: run(TOOLS.pax, ['--version'], { timeoutMs: 10_000 }).stdout.trim() || null, node: process.version },
    result: 'fail',
    gates: GATES.map((g) => gates.get(g)),
    ...(error ? { error: bounded(error, 2000) } : {}),
    startedAt, completedAt: nowIso(),
  };
  // The report itself must not carry private material.
  const leaks = leakedFiles(course, JSON.stringify(report));
  if (leaks.length) { const g = report.gates.find((x) => x.id === 'evaluator-isolated'); g.result = 'fail'; g.detail = `the preflight report contains private content from ${leaks.join(', ')}`; }
  report.result = !error && report.gates.every((g) => g.result === 'pass') ? 'pass' : 'fail';
  return report;
}
