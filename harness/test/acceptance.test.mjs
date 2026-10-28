// acceptance.v1: schema (shared with the app), interpreter, and explicit evaluator resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAcceptanceV1, validateCourseAcceptance, argvProblems, leafChecks } from '../../feltkit/lib/acceptance-v1.js';
import { runDeclarative, jsonPointer } from '../evaluator/declarative.mjs';
import { resolveEvaluator, evaluatorEnv } from '../evaluator/index.mjs';
import { listCourses, loadCourseDir } from '../courses/index.mjs';
import { runDirect } from '../worker/direct.mjs';
import { ADAPTERS } from '../agents/index.mjs';
import { emptyMetrics } from '../agents/adapter.mjs';
import { run } from '../lib/proc.mjs';
import { isolate, pendingRun, courseVariant, privateCourse } from './helpers.mjs';

const spec = (of, extra = {}) => ({ schema: 'acceptance.v1', toolchain: ['node'], require: { kind: 'all', id: 'root', of }, preflight: { baseline: { mustFail: [of[0].id] } }, ...extra });
const NODE = { ecosystem: 'node-npm' };

test('schema: the shipped documents are valid; unknown kinds and fields are validation errors, never ignored', () => {
  for (const c of listCourses()) assert.deepEqual(validateCourseAcceptance(c.doc), [], c.id);
  const ok = spec([{ id: 'f', kind: 'files-exist', paths: ['a.txt'] }]);
  assert.deepEqual(validateAcceptanceV1(ok, NODE), []);
  const bad = (mut) => { const s = structuredClone(ok); mut(s); return validateAcceptanceV1(s, NODE).join('\n'); };
  assert.match(bad((s) => s.require.of.push({ id: 'x', kind: 'shell', script: 'true' })), /unknown check kind "shell"/);
  assert.match(bad((s) => { s.require.of[0].optional = true; }), /unknown field "optional"/);
  assert.match(bad((s) => { s.require.of[0].kind = undefined; }), /unknown check kind undefined/);
  assert.match(bad((s) => { s.schema = 'acceptance.v2'; }), /schema must be "acceptance.v1"/);
  assert.match(bad((s) => { s.require = s.require.of[0]; }), /explicit "all" or "any"/);
  assert.match(bad((s) => { delete s.require; }), /no implicit default/);
  assert.match(bad((s) => { s.require.of.push({ id: 'f', kind: 'files-exist', paths: ['b'] }); }), /"f" is not unique/);
  assert.match(bad((s) => s.require.of.push({ id: 'o', kind: 'output', of: 'later', stream: 'stdout', match: { contains: 'x' } })), /must name an earlier command or test/);
  assert.match(bad((s) => s.require.of.push({ id: 'm', kind: 'file-content', path: 'a', match: { contains: 'x', regex: 'y' } })), /exactly one of exact, contains, regex, jsonPointer/);
  assert.match(bad((s) => { s.preflight.baseline.mustFail = ['nope']; }), /"nope" is not a check/);
  assert.match(bad((s) => s.require.of.push({ id: 't', kind: 'test', argv: ['node', '--test'], timeoutSecs: 10, exit: { equals: 0 }, format: 'none', counts: { passed: { min: 1 } } })), /needs a format the harness can parse/);
  assert.match(bad((s) => s.require.of.push({ id: 'c', kind: 'command', argv: ['node', 'x.js'], timeoutSecs: 99999, exit: { equals: 0 } })), /timeoutSecs must be an integer 1-3600/);
  // composition nesting and size are bounded
  let deep = { id: 'leaf', kind: 'files-exist', paths: ['a'] };
  for (let i = 0; i < 4; i++) deep = { id: `n${i}`, kind: 'any', of: [deep] };
  assert.match(bad((s) => { s.require.of = [deep]; s.preflight.baseline.mustFail = ['leaf']; }), /nesting deeper than 4/);
  assert.equal(leafChecks(ok).length, 1);
});

test('schema: only approved programs as argv (no shell), from the fixture ecosystem and the declared toolchain; interpreter flags refused', () => {
  const ctx = { toolchain: ['node', 'cargo', 'npx', 'pnpm'], ecosystem: 'node-pnpm-vitest' };
  assert.deepEqual(argvProblems(['node', '--test'], 'a', ctx), []);
  assert.deepEqual(argvProblems(['npx', 'vitest', 'run', 'spec/x.test.ts'], 'a', ctx), []);
  assert.deepEqual(argvProblems(['pnpm', 'install', '--frozen-lockfile'], 'a', ctx), []);
  const p = (argv, c = ctx) => argvProblems(argv, 'a', c).join('\n');
  assert.match(p(['bash', '-c', 'true']), /not an approved program/);
  assert.match(p(['/usr/bin/node', 'x.js']), /not an approved program/);
  assert.match(p('node x.js'), /array of 1-32 strings/);
  assert.match(p(['node', '-e', '1']), /"node -e" is refused/);
  assert.match(p(['node', '--eval=1']), /"node --eval" is refused/);
  assert.match(p(['node', '--require', './hook.js', 'x.js']), /"node --require" is refused/);
  assert.match(p(['npx', '-y', 'cowsay']), /refused/);
  assert.match(p(['npx', 'some-package']), /approved subcommands/);
  assert.match(p(['pnpm', 'dlx', 'x']), /approved subcommands/);
  assert.match(p(['cargo', 'test']), /not approved for the fixture's ecosystem "node-pnpm-vitest"/);
  assert.match(p(['node', 'x.js'], { toolchain: [], ecosystem: 'node-npm' }), /not listed in acceptance.toolchain/);
  assert.match(p(['cargo', 'install', 'x'], { toolchain: ['cargo'], ecosystem: 'rust-cargo' }), /approved subcommands/);
});

/** A tiny git fixture + evaluation tree for the interpreter (no cargo needed). */
function sandbox(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'aoc-decl-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = join(root, 'fixture'); mkdirSync(fx);
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(fx, p, '..'), { recursive: true }); writeFileSync(join(fx, p), c); }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
  run('git', ['init', '-q', '-b', 'main'], { cwd: fx, env }); run('git', ['add', '-A'], { cwd: fx, env }); run('git', ['commit', '-qm', 'f'], { cwd: fx, env });
  const fixture = { tree: fx, baseCommit: run('git', ['rev-parse', 'HEAD'], { cwd: fx }).stdout.trim(), refs: run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: fx }).stdout.trim() };
  const tree = join(root, 'tree'); cpSync(fx, tree, { recursive: true });
  const outDir = join(root, 'out'); mkdirSync(outDir);
  return { root, fixture, tree, outDir, go: (s) => runDeclarative({ spec: s, ecosystem: 'node-npm', tree, fixture, workspace: fx, env: evaluatorEnv(outDir), outDir }) };
}

test('interpreter: every check kind runs in the evaluation tree, records whether it executed, and composes explicitly', async (t) => {
  const sb = sandbox(t, { 'a.txt': 'hello world\n', 'data.json': '{"a":{"b":[1,2,{"c":true}]},"x/y":1}', 'ok.js': 'console.log(JSON.stringify({status:"green",n:3}))', 'bad.js': 'process.exit(3)' });
  writeFileSync(join(sb.tree, 'a.txt'), 'hello there\n');           // the "agent" changed a.txt
  const s = spec([
    { id: 'exists', kind: 'files-exist', paths: ['a.txt', 'data.json'] },
    { id: 'contains', kind: 'file-content', path: 'a.txt', match: { contains: 'there' } },
    { id: 'regex', kind: 'file-content', path: 'a.txt', match: { regex: '^hello\\s+t', flags: 'm' } },
    { id: 'pointer', kind: 'file-content', path: 'data.json', match: { jsonPointer: '/a/b/2/c', equals: true } },
    { id: 'escaped-pointer', kind: 'file-content', path: 'data.json', match: { jsonPointer: '/x~1y', equals: 1 } },
    { id: 'cmd', kind: 'command', argv: ['node', 'ok.js'], timeoutSecs: 30, exit: { equals: 0 } },
    { id: 'out', kind: 'output', of: 'cmd', stream: 'stdout', match: { jsonPointer: '/status', equals: 'green' } },
    { id: 'bad-exit', kind: 'command', argv: ['node', 'bad.js'], timeoutSecs: 30, exit: { in: [3, 4] } },
    { id: 'unchanged', kind: 'invariant', invariant: 'unchanged', paths: ['data.json'] },
    { id: 'absent', kind: 'invariant', invariant: 'absent', paths: ['secret.txt'] },
    { id: 'no-commits', kind: 'invariant', invariant: 'no-commits' },
    { id: 'either', kind: 'any', of: [{ id: 'nope', kind: 'files-exist', paths: ['missing.txt'] }, { id: 'yes', kind: 'files-exist', paths: ['a.txt'] }] },
  ]);
  assert.deepEqual(validateAcceptanceV1(s, NODE), []);
  const r = await sb.go(s);
  const by = Object.fromEntries(r.records.map((x) => [x.id, x]));
  for (const id of ['exists', 'contains', 'regex', 'pointer', 'escaped-pointer', 'cmd', 'out', 'bad-exit', 'unchanged', 'absent', 'no-commits', 'yes', 'either']) assert.equal(by[id].result, 'pass', `${id}: ${by[id].detail}`);
  assert.equal(by.nope.result, 'fail');
  assert.ok(r.records.every((x) => x.executed));
  assert.equal(r.result, 'pass');
  // a changed file breaks "unchanged"
  const r2 = await sb.go(spec([{ id: 'u', kind: 'invariant', invariant: 'unchanged', paths: ['a.txt'] }]));
  assert.equal(r2.result, 'fail');
  assert.equal(jsonPointer({ a: [0, 1] }, '/a/01').found, false);
});

test('interpreter: nothing passes without having run — timeouts, unparseable counts, escaping symlinks, run-time validation', async (t) => {
  const sb = sandbox(t, { 'slow.js': 'setTimeout(() => console.log("late"), 5000)', 'quiet.js': '', 'a.txt': 'x' });
  symlinkSync('/etc/hostname', join(sb.tree, 'link.txt'));
  // an output check on a timed-out command is not-run (never pass); the composition is then not a pass
  const r1 = await sb.go(spec([
    { id: 'slow', kind: 'command', argv: ['node', 'slow.js'], timeoutSecs: 1, exit: { equals: 0 } },
    { id: 'late', kind: 'output', of: 'slow', stream: 'stdout', match: { contains: 'late' } },
  ]));
  const by1 = Object.fromEntries(r1.records.map((x) => [x.id, x]));
  assert.deepEqual([by1.slow.result, by1.slow.detail], ['fail', 'timed out after 1s']);
  assert.deepEqual([by1.late.result, by1.late.executed], ['not-run', false]);
  assert.notEqual(r1.result, 'pass');
  // any() over an unexecuted check and a failing one is an error, not a pass
  const r1b = await sb.go(spec([{ id: 'slow2', kind: 'command', argv: ['node', 'slow.js'], timeoutSecs: 1, exit: { equals: 0 } }, { id: 'either', kind: 'any', of: [{ id: 'late2', kind: 'output', of: 'slow2', stream: 'both', match: { contains: 'late' } }, { id: 'gone', kind: 'files-exist', paths: ['gone'] }] }]));
  assert.equal(r1b.records.find((x) => x.id === 'either').result, 'error');
  // counts that the harness cannot read are an error, never a pass
  const r2 = await sb.go(spec([{ id: 'quiet', kind: 'test', argv: ['node', 'quiet.js'], timeoutSecs: 30, exit: { equals: 0 }, format: 'vitest', counts: { failed: { equals: 0 } } }]));
  assert.equal(r2.records.find((x) => x.id === 'quiet').result, 'error');
  assert.equal(r2.result, 'error');
  assert.equal(r2.failureClass, 'evaluator');
  // a symlink out of the evaluation tree is not followed
  const r3 = await sb.go(spec([{ id: 'link', kind: 'file-content', path: 'link.txt', match: { contains: 'a' } }, { id: 'link-exists', kind: 'files-exist', paths: ['link.txt'] }]));
  assert.match(r3.records.find((x) => x.id === 'link').detail, /leaves the evaluation tree/);
  assert.equal(r3.records.find((x) => x.id === 'link-exists').result, 'fail');
  // the interpreter re-validates: an invalid spec runs nothing and is an evaluator error
  const r4 = await sb.go(spec([{ id: 'x', kind: 'shell', script: 'touch pwned' }]));
  assert.equal(r4.result, 'error');
  assert.match(r4.error, /unknown check kind "shell"/);
  assert.deepEqual([r4.records.length, r4.steps.length], [0, 0]);
});

const fakeAgent = (id, act) => ({ id, control: false, needsModel: false, version: () => 'fake-1', async run(req) {
  const t0 = Date.now(); await act?.(req);
  return { adapter: id, version: 'fake-1', control: false, claims: { agentTerminalState: 'completed', agentSaysVerified: true }, observed: { exitCode: 0, signal: null, durationMs: Date.now() - t0, timedOut: false }, metrics: emptyMetrics(), launches: [], observations: [], artifacts: [] };
} });
const runVariant = (root, c, adapter = 'reference-control', adapters = ADAPTERS) => runDirect({ runId: `r-${c.id}-${adapter}`, input: pendingRun({ runId: `r-${c.id}-${adapter}`, course: c, adapter }), adapters, coursesRoot: join(root, 'courses') });

test('explicit evaluator resolution: none, missing, invalid → ERROR (never PASS or FAIL), before the agent runs', async (t) => {
  const root = await isolate(t);
  const courses = join(root, 'courses');
  const none = courseVariant(courses, 'ev-none', (d) => { d.evaluator = { kind: 'none', reason: 'acceptance not written yet' }; });
  const missing = courseVariant(courses, 'ev-missing', (d) => { delete d.evaluator; });
  const invalid = courseVariant(courses, 'ev-invalid', (d) => { d.acceptance.require.of.push({ id: 'judge', kind: 'llm-judge', prompt: 'looks fine?' }); });
  const privNoDir = courseVariant(courses, 'ev-private-nodir', (d) => { d.evaluator = { kind: 'private', dir: 'evaluator', version: '1', digest: 'a'.repeat(64) }; });
  for (const [c, re] of [[none, /kind "none"/], [missing, /evaluator is required/], [invalid, /unknown check kind "llm-judge"/], [privNoDir, /evaluator-invalid|evaluator directory/]]) {
    const r = await runVariant(root, c);
    assert.equal(r.result.outcome, 'ERROR', c.id);
    assert.equal(r.result.failureClass, 'evaluator', c.id);
    assert.equal(r.result.evaluation.acceptance, 'not-run');
    assert.match(r.result.evaluation.checks[0].detail, re, c.id);
    assert.equal(r.state.agent, undefined, `${c.id}: the agent never ran`);
    assert.throws(() => resolveEvaluator(c), { failureClass: 'evaluator' });
  }
});

test('tampering is detected at evaluation: a private evaluator or a course document changed during the run → ERROR', async (t) => {
  const root = await isolate(t);
  const courses = join(root, 'courses');
  const priv = privateCourse(courses, 'tamper-private');
  const decl = courseVariant(courses, 'tamper-decl');
  // the "agent" applies the fix and then weakens the private evaluator's hidden test
  const weaken = fakeAgent('weaken', async (req) => {
    run('git', ['apply', join(req.course.dir, 'evaluator/reference/fix.diff')], { cwd: req.workspace });
    writeFileSync(join(req.course.dir, 'evaluator/acceptance/span_acceptance.rs'), '#[test] fn ok() {}\n');
  });
  const r1 = await runVariant(root, priv, 'weaken', { ...ADAPTERS, weaken });
  assert.equal(r1.result.outcome, 'ERROR');
  assert.equal(r1.result.failureClass, 'evaluator');
  assert.match(r1.result.evaluation.checks.find((c) => c.id === 'evaluator').detail, /evaluator-digest-mismatch/);
  assert.ok(r1.result.evaluation.violations.some((v) => v.id === 'workspace-only' && v.severity === 'critical'));
  // the "agent" rewrites the declarative acceptance in the course document to accept anything
  const loosen = fakeAgent('loosen', async (req) => {
    const p = join(req.course.dir, 'course.json');
    const d = JSON.parse(readFileSync(p, 'utf8'));
    d.acceptance.require = { kind: 'any', id: 'accept', of: [{ id: 'anything', kind: 'files-exist', paths: ['src/lib.rs'] }] };
    d.acceptance.preflight = { baseline: { mustFail: ['anything'] } };
    writeFileSync(p, JSON.stringify(d));
  });
  const r2 = await runVariant(root, decl, 'loosen', { ...ADAPTERS, loosen });
  assert.equal(r2.result.outcome, 'ERROR');
  assert.match(r2.result.evaluation.checks.find((c) => c.id === 'evaluator').detail, /course-digest-mismatch/);
  assert.equal(r2.result.reproducibility.acceptanceDigest, `sha256:${(await import('../lib/util.mjs')).canonicalDigest(decl.doc.acceptance)}`, 'provenance keeps the pinned acceptance');
  assert.equal(loadCourseDir(decl.dir).doc.acceptance.require.kind, 'any');
});
