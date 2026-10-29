// Experiment configuration for Stack-Agent A/B runs: build selection, context profile, prompt cache, run labels.
// Unit checks need nothing; the arm checks run the selected build (stack-agent-builds.json) against local fake
// model servers that record every request, and are skipped when that build is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENAI_API_KEY = 'sk-host-secret-must-not-leak-42';
process.env.FELTKIT_CREDENTIAL_ANTHROPIC = 'sk-ant-fake-held-by-the-proxy';

const { resolveStackAgentConfig, configArgs, runLabels, effectiveFromReport, tokenTotals, loadBuilds, buildsDir } = await import('../agents/stack-agent-config.mjs');
const { workArgs } = await import('../agents/stack-agent.mjs');
const { isolate, pendingRun, startFakeOpenAI } = await import('./helpers.mjs');
const { loadCourseRef } = await import('../courses/index.mjs');
const { runDirect } = await import('../worker/direct.mjs');
const { sha256File } = await import('../lib/util.mjs');

const course = loadCourseRef('course-000-calibration/v2');
const FIX = readFileSync(new URL('./fixtures/course-000-stack-agent-fix.script', import.meta.url), 'utf8').trim().split('\n');
const BUILD = 'adaptive-4a9b05b';
const BIN = join(buildsDir(), `stack-agent-${loadBuilds()[BUILD].commit}`);
const haveBuild = existsSync(BIN);

/** A fake executable that answers --version and `work --help` (with or without the new flags). */
function fakeBinary(t, { flags }) {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-fakebin-'));
  const p = join(dir, 'stack-agent');
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "stack-agent 0.0.0-fake"; exit 0; fi\necho "usage: stack-agent work${flags ? ' [--context-profile P] [--prompt-cache on|off]' : ''}"\n`);
  chmodSync(p, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return p;
}

test('config: values are validated; unknown builds, missing binaries and unsupported flags are refused, never dropped', (t) => {
  const old = fakeBinary(t, { flags: false });
  const neu = fakeBinary(t, { flags: true });
  assert.throws(() => resolveStackAgentConfig({ contextProfile: 'turbo' }, { defaultBinary: neu }), /contextProfile must be one of replay, auto/);
  assert.throws(() => resolveStackAgentConfig({ promptCache: 'yes' }, { defaultBinary: neu }), /promptCache must be on or off/);
  assert.throws(() => resolveStackAgentConfig({ runLabel: 'has space' }, { defaultBinary: neu }), /runLabel must be/);
  assert.throws(() => resolveStackAgentConfig({ build: 'nope' }, { defaultBinary: neu }), /not a known Stack-Agent build/);
  assert.throws(() => resolveStackAgentConfig({ build: BUILD }, { dir: '/nonexistent' }), /is not installed at \/nonexistent\/stack-agent-4a9b05b/);
  assert.throws(() => resolveStackAgentConfig({ contextProfile: 'auto' }, { defaultBinary: old }), /has no --context-profile/);
  assert.throws(() => resolveStackAgentConfig({ promptCache: 'off' }, { defaultBinary: old }), /has no --prompt-cache/);
  try { resolveStackAgentConfig({ contextProfile: 'auto' }, { defaultBinary: old }); } catch (e) { assert.equal(e.failureClass, 'environment'); }
  // Nothing set: the default binary, no extra flags — exactly what ran before this change.
  const plain = resolveStackAgentConfig({}, { defaultBinary: old });
  assert.deepEqual(configArgs(plain), []);
  assert.equal(plain.binary.build, null);
  assert.equal(plain.binary.version, 'stack-agent 0.0.0-fake');
  assert.match(plain.binary.sha256, /^[0-9a-f]{64}$/);
  const set = resolveStackAgentConfig({ contextProfile: 'auto', promptCache: 'off', runLabel: 'ab1-auto' }, { defaultBinary: neu });
  assert.deepEqual(configArgs(set), ['--context-profile', 'auto', '--prompt-cache', 'off']);
});

test('config: flags reach the command line only when set; run labels follow Stack-Agent\'s grammar', () => {
  const req = { objective: { goal: 'g' }, budgets: { maxTurns: 1, maxExecutions: 1, callTimeoutSecs: 30 }, model: { provider: 'anthropic', model: 'm', endpoint: 'e' }, runId: 'r1', options: {} };
  const base = workArgs(req, { stateDb: 's', leaseSecs: 90, deadlineSecs: 9 });
  const cfg = { contextProfile: 'replay', promptCache: 'on', runLabel: 'ab1-replay' };
  const withCfg = workArgs(req, { stateDb: 's', leaseSecs: 90, deadlineSecs: 9, config: cfg });
  assert.deepEqual(withCfg.filter((a) => !base.includes(a)), ['--context-profile', 'replay', '--prompt-cache', 'on']);
  assert.equal(withCfg.at(-1), '--json');
  assert.deepEqual(workArgs(req, { stateDb: 's', leaseSecs: 90, deadlineSecs: 9, config: { contextProfile: null, promptCache: null } }), base);
  const labels = runLabels(cfg, { runId: 'mvs1', courseRef: 'course-000-calibration@v2', obstacle: 'transient-test-failure' });
  assert.equal(labels, 'run=mvs1,course=course-000-calibration@v2,obstacle=transient-test-failure,arm=ab1-replay');
  for (const part of labels.split(',')) assert.match(part, /^[a-z0-9_.-]{1,32}=[\x20-\x7e]{1,128}$/);
  assert.ok(!labels.split(',').some((p) => p.split('=').length !== 2));
});

test('config: effective settings and token totals come from the agent\'s report; unknown stays null', () => {
  assert.deepEqual(effectiveFromReport(null), { contextProfile: null, promptCache: null, promptCacheSource: null, runLabels: null });
  const rep = { tuning: { context_profile: 'auto' }, generation: { prompt_cache: { value: true, source: 'flag:--prompt-cache' } }, token_usage: { run: { labels: { arm: 'x' } }, totals: {
    cache_read_tokens: { sum: 10, calls_known: 2, calls_unknown: 0 }, cache_write_tokens: { sum: 5, calls_known: 1, calls_unknown: 1 },
    uncached_input_tokens: { sum: 0, calls_known: 2, calls_unknown: 0 }, total_input_tokens: { sum: null, calls_known: 0, calls_unknown: 2 } } } };
  assert.deepEqual(effectiveFromReport(rep), { contextProfile: 'auto', promptCache: 'on', promptCacheSource: 'flag:--prompt-cache', runLabels: { arm: 'x' } });
  assert.deepEqual(tokenTotals(rep), { cacheReadTokens: 10, cacheWriteTokens: null, uncachedInputTokens: 0, totalInputTokens: null });
  assert.deepEqual(tokenTotals({}), { cacheReadTokens: null, cacheWriteTokens: null, uncachedInputTokens: null, totalInputTokens: null });
});

const arm = (contextProfile, extra = {}) => ({ build: BUILD, contextProfile, runLabel: `ab-${contextProfile}`, ...extra });
const firstSystem = (body) => (body.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
const report = (r) => JSON.parse(readFileSync(join(r.runDir, 'agent', 'report.1.json'), 'utf8').trim().split('\n').at(-1));

test('A/B arms (replay vs auto, OpenAI-compatible fake): same build, same task, evaluator and inputs; only the profile and label differ; everything recorded', { skip: !haveBuild && `build ${BUILD} not installed at ${BIN}` }, async (t) => {
  await isolate(t);
  const runs = {};
  for (const profile of ['replay', 'auto']) {
    const m = await startFakeOpenAI(t, { replies: FIX });
    const runId = `ab-oai-${profile}`;
    const input = pendingRun({ runId, course, adapter: 'stack-agent', options: arm(profile, { promptCache: 'off' }), model: { provider: 'openai-compatible', model: 'scripted', endpoint: m.url }, obstacles: { enabled: true, overrides: { variant: 'transient-test-failure' } } });
    runs[profile] = { r: await runDirect({ runId, input }), seen: m.seen.filter((s) => s.method === 'POST'), input };
  }
  const { replay, auto } = runs;
  for (const [profile, { r }] of Object.entries(runs)) {
    assert.equal(r.result.outcome, 'PASS', `${profile}: ${JSON.stringify(r.result.evaluation?.checks?.filter((c) => c.result !== 'pass'))}`);
    const rp = r.result.reproducibility;
    assert.equal(rp.agentBinary.build, BUILD);
    assert.equal(rp.agentBinary.commit, '4a9b05b');
    assert.equal(rp.agentBinary.path, BIN);
    assert.equal(rp.agentBinary.sha256, sha256File(BIN));
    assert.deepEqual(rp.agentConfig.requested, { contextProfile: profile, promptCache: 'off', runLabel: `ab-${profile}` });
    assert.equal(rp.agentConfig.effective.contextProfile, profile, 'the agent reports the profile it ran with');
    assert.equal(rp.agentConfig.effective.promptCache, 'off');
    assert.match(rp.agentConfig.runLabels, new RegExp(`arm=ab-${profile}`));
    assert.equal(rp.agentConfig.effective.runLabels.arm, `ab-${profile}`, 'labels survive into the agent\'s own ledger');
    assert.equal(rp.agentConfig.effective.runLabels.course, 'course-000-calibration@v2');
    assert.equal(rp.agentConfig.effective.runLabels.obstacle, 'transient-test-failure');
    const ev = readFileSync(join(r.runDir, 'evidence.jsonl'), 'utf8');
    assert.match(ev, /config:agent/);
  }
  // Identical between arms: course, fixture, evaluator, budgets, model, obstacle, goal and the instructions sent.
  const a = replay.r.result.reproducibility, b = auto.r.result.reproducibility;
  for (const k of ['courseDigest', 'fixtureDigest', 'evaluatorVersion', 'paxVersion']) assert.equal(a[k], b[k], k);
  assert.deepEqual(a.evaluator ?? null, b.evaluator ?? null);
  const defA = replay.input.experiment, defB = auto.input.experiment;
  for (const k of ['budgets', 'obstacles', 'environment']) assert.deepEqual(defA[k], defB[k], k);
  assert.deepEqual({ ...defA.model, endpoint: null }, { ...defB.model, endpoint: null }, 'same model (each arm has its own fake server)');
  assert.deepEqual({ ...defA.agent.options, contextProfile: null, runLabel: null }, { ...defB.agent.options, contextProfile: null, runLabel: null });
  assert.notEqual(a.experimentDigest, b.experimentDigest, 'the arms are different experiments');
  assert.equal(firstSystem(replay.seen[0].body), firstSystem(auto.seen[0].body), 'same instructions, goal and reply contract on the first request');
  assert.equal(replay.seen[0].body.model, auto.seen[0].body.model);
  // replay is the legacy request: no adaptive-context state block anywhere in what it sent.
  assert.ok(replay.seen.every((s) => !JSON.stringify(s.body).includes('Context profile')));
});

/** A fake Anthropic Messages endpoint: replies with the scripted decisions as SSE and reports cache usage. */
async function startFakeAnthropic(t, replies) {
  const seen = [];
  let i = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ url: req.url, headers: req.headers, body });
    const text = replies[Math.min(i++, replies.length - 1)];
    const cached = JSON.stringify(body.system ?? '').includes('cache_control');
    const usage = { input_tokens: 100, cache_read_input_tokens: cached && i > 1 ? 900 : 0, cache_creation_input_tokens: cached && i === 1 ? 900 : 0, output_tokens: 1 };
    const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    ev('message_start', { type: 'message_start', message: { id: `m${i}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('prompt cache (Anthropic fake, replay): on sends a cache breakpoint, off does not; the effective setting and cache tokens are recorded', { skip: !haveBuild && `build ${BUILD} not installed at ${BIN}` }, async (t) => {
  await isolate(t);
  const out = {};
  for (const promptCache of ['on', 'off']) {
    const m = await startFakeAnthropic(t, FIX);
    const runId = `ab-anth-${promptCache}`;
    const input = pendingRun({ runId, course, adapter: 'stack-agent', options: arm('replay', { promptCache, runLabel: `cache-${promptCache}` }), model: { provider: 'anthropic', model: 'claude-fake', endpoint: m.url, credentialRef: 'credential-ref:anthropic' }, obstacles: { enabled: true, overrides: { variant: 'transient-test-failure' } } });
    out[promptCache] = { r: await runDirect({ runId, input }), seen: m.seen };
  }
  for (const [pc, { r, seen }] of Object.entries(out)) {
    assert.equal(r.result.outcome, 'PASS', pc);
    assert.ok(seen.length >= 2, `${pc}: model called`);
    const marked = seen.map((s) => JSON.stringify(s.body.system ?? '').includes('cache_control'));
    assert.ok(marked.every((x) => x === (pc === 'on')), `${pc}: cache_control on every request iff on (${marked})`);
    assert.equal(seen[0].headers['x-api-key'], 'sk-ant-fake-held-by-the-proxy', 'the proxy holds the key');
    const rp = r.result.reproducibility.agentConfig;
    assert.equal(rp.requested.promptCache, pc);
    assert.equal(rp.effective.promptCache, pc);
    assert.equal(rp.effective.contextProfile, 'replay');
    const m = r.result.metrics;
    assert.equal(typeof m.cacheReadTokens, 'number', `${pc}: cache reads recorded`);
    assert.equal(typeof m.cacheWriteTokens, 'number', `${pc}: cache writes recorded`);
    assert.equal(m.cacheReadTokens > 0, pc === 'on');
  }
  // Apart from the breakpoint, the two arms send the same system text.
  const sys = (s) => (Array.isArray(s.body.system) ? s.body.system.map((b) => b.text).join('') : s.body.system);
  assert.equal(sys(out.on.seen[0]), sys(out.off.seen[0]));
});
