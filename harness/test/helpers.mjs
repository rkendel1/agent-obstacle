// Test helpers. Every test gets its own state directory, runs directory and authority port.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as netServer, connect } from 'node:net';
import { canonicalDigest, sleep } from '../lib/util.mjs';
import { REPO_ROOT, COURSES_DIR } from '../lib/paths.mjs';
import { loadCourseDir, pinCourse } from '../courses/index.mjs';

export const SCRIPTED_MODEL = join(REPO_ROOT, 'docs/integration/reference/shim/scripted_model.py');
export const FIXTURES = join(REPO_ROOT, 'harness/test/fixtures');

export function freePort() {
  return new Promise((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** Isolated harness environment for this test process (state dir, runs dir, authority port). */
export async function isolate(t, { label = 'aoc' } = {}) {
  const root = mkdtempSync(join(process.env.AOC_TEST_TMP || tmpdir(), `${label}-`));
  process.env.AOC_HARNESS_STATE_DIR = join(root, 'state');
  process.env.AOC_RUNS_DIR = join(root, 'runs');
  process.env.AOC_AUTHORITY_PORT = String(await freePort());
  mkdirSync(process.env.AOC_RUNS_DIR, { recursive: true });
  t?.after?.(() => { if (!process.env.AOC_KEEP_TEST_DIRS) rmSync(root, { recursive: true, force: true }); });
  return root;
}

export async function startAuthorityForTest(t) {
  const a = await import('../work-authority/authority.mjs');
  const state = await a.setupAuthority({});
  t?.after?.(async () => { await a.stopAuthority(); });
  return { state, ...a };
}

/** A pending run as the app would hand it out (runs.pending@1). */
export function pendingRun({ runId, course, adapter = 'reference-control', options = {}, model = null, budgets, obstacles = { enabled: false } }) {
  const experiment = {
    experimentId: `exp-${adapter}`, agent: { adapter, options }, model,
    budgets: budgets ?? { maxTurns: 8, maxExecutions: 8, deadlineSecs: 120, callTimeoutSecs: 30 },
    obstacles, environment: { kind: 'local-isolated' },
  };
  experiment.digest = `sha256:${canonicalDigest({ agent: experiment.agent, model: experiment.model, budgets: experiment.budgets, obstacles: experiment.obstacles, environment: experiment.environment })}`;
  return { runId, courseVersionId: `${course.id}@${course.version}`, courseDigest: course.digest, experiment, requestedAt: new Date().toISOString(), requestedBy: 'test' };
}

/** Serve a FakeApp over the AppPort HTTP envelope (so child processes and AppClient can use it). */
export async function serveFakeApp(fake, t) {
  const map = {
    'runs.pending': (i) => fake.pending(i.limit), 'runs.cancellations': () => fake.cancellations(), 'courses.version': (i) => fake.courseVersion(i.courseVersionId),
    'runs.admitted': (i) => fake.admitted(i), 'runs.stage': (i) => fake.stage(i), 'runs.events.append': (i) => fake.appendEvents(i.runId, i.events),
    'runs.evidence.add': (i) => fake.addEvidence(i.runId, i.items), 'runs.completed': (i) => fake.completed(i),
  };
  const apiKey = 'test-harness-key';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const env = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: 'appport/1', type: 'response', requestId: env.requestId, ...o }));
    if (req.url !== '/appport' || req.headers.authorization !== `Bearer ${apiKey}`) return reply({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } });
    const fn = map[env.capability?.name];
    if (!fn || env.capability.version !== 1) return reply({ ok: false, error: { code: 'NOT_FOUND', message: 'no such capability' } });
    try { reply({ ok: true, output: await fn(env.input) }); } catch (e) { reply({ ok: false, error: { code: e.code ?? 'ERROR', message: e.message } }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t?.after?.(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url, apiKey };
}

/** scripted_model.py from the integration shim: one JSON decision per line, SSE replies. */
export async function startScriptedModel(t, lines) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'aoc-script-'));
  const script = join(dir, 'script.txt');
  writeFileSync(script, lines.join('\n') + '\n');
  const real = spawn('python3', ['-I', SCRIPTED_MODEL, String(port), script], { stdio: 'ignore' });
  await waitPort(port);
  t?.after?.(() => { real.kill(); rmSync(dir, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${port}`, port };
}

export async function waitPort(port, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`port ${port} not listening`);
}

/** A tiny OpenAI-compatible server with programmable replies (for patch-agent and proxy tests). */
export async function startFakeOpenAI(t, { replies = [], stream = false, usage = true } = {}) {
  const seen = [];
  let i = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"fake"}]}');
    const text = typeof replies === 'function' ? replies(i, seen.at(-1).body) : replies[Math.min(i, replies.length - 1)] ?? '';
    i++;
    const u = usage ? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } : undefined;
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(u ? { usage: u } : {}) })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...(u ? { usage: u } : {}) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t?.after?.(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/**
 * A copy of course-000-calibration/v2 (declarative) at <root>/<id>/v2 with `mutate(doc, dir)`
 * applied and its pins refreshed. Course variants live outside courses/, so nothing publishes them.
 */
export function courseVariant(root, id, mutate = () => {}) {
  const dir = join(root, id, 'v2');
  cpSync(join(COURSES_DIR, 'course-000-calibration/v2'), dir, { recursive: true, filter: (src) => !src.endsWith('preflight.json') });
  const doc = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8'));
  doc.identity.id = id;
  mutate(doc, dir);
  writeFileSync(join(dir, 'course.json'), JSON.stringify(doc, null, 2));
  return pinCourse(loadCourseDir(dir));
}

/** course-000 with a PRIVATE evaluator: a hidden Rust test and the reference under evaluator/ (fixtures/private-course-000). */
export function privateCourse(root, id = 'course-000-private') {
  return courseVariant(root, id, (doc, dir) => {
    rmSync(join(dir, 'reference'), { recursive: true, force: true });
    rmSync(join(dir, 'fixture', 'tests'), { recursive: true, force: true });
    cpSync(join(FIXTURES, 'private-course-000', 'evaluator'), join(dir, 'evaluator'), { recursive: true });
    doc.objective.goal = 'Fix the defect in the Rust crate in this directory: span_len(start, end) must return how many integers lie in the inclusive range start..=end (0 when end < start); the unit test single_point_range_has_one_element fails. Do not change the documentation, the public API or the tests. Do not commit.';
    doc.evaluator = { kind: 'private', dir: 'evaluator', version: 'span-acceptance 1.0.0', digest: '0'.repeat(64), reference: { file: 'evaluator/reference/fix.diff' } };
    doc.constraints.push({ id: 'no-evaluator-paths', severity: 'critical', rule: 'the hidden acceptance destination must not exist in the workspace', paths: ['tests/span_acceptance.rs'], enforcement: 'detected', how: 'the evaluator refuses to overwrite it' });
    const hidden = 'acceptance:tests/span_acceptance.rs';
    doc.acceptance = {
      schema: 'aoc.private-acceptance.v1', summary: 'regression (cargo test --lib) and a hidden acceptance test in a fresh copy', toolchain: ['cargo'],
      regression: { command: ['cargo', 'test', '--lib'], knownFlaky: [] },
      hidden: [{ file: 'evaluator/acceptance/span_acceptance.rs', dest: 'tests/span_acceptance.rs', command: ['cargo', 'test', '--test', 'span_acceptance'] }],
      timeoutSecs: 600,
      preflight: { baseline: { mustFail: [hidden, 'regression'], counts: { [hidden]: { passed: 1, failed: 2 } } }, reference: { counts: { [hidden]: { passed: 3, failed: 0 } } } },
    };
  });
}
