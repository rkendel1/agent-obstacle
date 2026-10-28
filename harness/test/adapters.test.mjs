// Agent adapters with deterministic models: Stack-Agent driven by the integration shim's
// scripted_model.py, patch-agent driven by a programmable OpenAI-compatible fake.
// The real PAX is wrapped so the test can see the environment the agent's tools run with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapDir = mkdtempSync(join(tmpdir(), 'aoc-paxwrap-'));
const ENV_DUMP = join(wrapDir, 'env-dumps.txt');
writeFileSync(join(wrapDir, 'pax'), `#!/bin/sh\n{ echo '--- pax' "$@"; env; } >> '${ENV_DUMP}'\nexec /root/.local/bin/pax "$@"\n`);
chmodSync(join(wrapDir, 'pax'), 0o755);
process.env.AOC_PAX_BIN = join(wrapDir, 'pax');
process.on('exit', () => rmSync(wrapDir, { recursive: true, force: true }));
const SECRET = 'sk-host-secret-must-not-leak-42';
process.env.OPENAI_API_KEY = SECRET;            // a host credential the agent must never see
process.env.ANTHROPIC_API_KEY = SECRET;
process.env.FELTKIT_CREDENTIAL_LOCALMODEL = 'cred-value-held-by-the-proxy-77';

const { isolate, pendingRun, startScriptedModel, startFakeOpenAI } = await import('./helpers.mjs');
const { loadCourseRef } = await import('../courses/index.mjs');
const { runDirect } = await import('../worker/direct.mjs');
const { agentEnv, DENY } = await import('../agents/adapter.mjs');
const { extractDiff, keywords } = await import('../agents/patch-agent.mjs');

const course = loadCourseRef('course-000-calibration/v2');
const FIX = readFileSync(new URL('./fixtures/course-000-stack-agent-fix.script', import.meta.url), 'utf8').trim().split('\n');
const model = (url, extra = {}) => ({ provider: 'openai-compatible', model: 'scripted', endpoint: url, ...extra });
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('agentEnv is an allowlist: no host credentials, PAX shim first on PATH', () => {
  const env = agentEnv({ runDir: '/r', paxBin: '/r/bin/pax' });
  assert.equal(env.PATH.split(':')[0], '/r/bin');
  for (const k of Object.keys(env)) assert.ok(!DENY.test(k), k);
  assert.ok(!Object.values(env).includes(SECRET));
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('stack-agent + scripted model: transient pax failure recognized and recovered, verified, PASS; no secret reaches the agent', async (t) => {
  await isolate(t);
  const m = await startScriptedModel(t, FIX);
  const runId = 'sa-scripted-1';
  const r = await runDirect({ runId, input: pendingRun({ runId, course, adapter: 'stack-agent', model: model(m.url, { credentialRef: 'credential-ref:localmodel' }), obstacles: { enabled: true, overrides: { variant: 'transient-test-failure' } } }) });
  assert.equal(r.result.outcome, 'PASS');
  assert.equal(r.result.claims.agentTerminalState, 'completed');
  assert.equal(r.result.claims.agentSaysVerified, true);
  assert.equal(r.result.observed.exitCode, 0);
  assert.deepEqual(r.result.recovery.map((x) => [x.obstacleId, x.injected, x.recognized, x.recovered]), [['transient-test-failure', true, true, true]]);
  assert.equal(r.result.metrics.paxTestsInjected, 1);
  assert.equal(r.result.metrics.modelCallsObserved, r.result.metrics.modelCallsReported);
  assert.ok(r.result.metrics.inputTokensReported > 0, 'usage restored by the proxy');
  const events = readFileSync(join(r.runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"kind":"obstacle.injected"/);
  // the agent's tools ran with the allowlisted env: no host credential, no resolved credential
  const dumps = readFileSync(ENV_DUMP, 'utf8');
  assert.match(dumps, /--- pax .*test/);
  assert.ok(!dumps.includes(SECRET), 'host OPENAI/ANTHROPIC key not in the agent environment');
  assert.ok(!dumps.includes('cred-value-held-by-the-proxy-77'), 'resolved credential not in the agent environment');
  assert.match(dumps, /CHIP_API_KEY=local-placeholder/);
  assert.match(dumps, /STACK_AGENT_DATA_DIR=.*agent-data/);
  // no secret in any run file (logs, events, evidence, agent state)
  for (const f of walk(r.runDir).filter((p) => !p.includes('/target/') && !p.includes('/workspace/.git/'))) {
    const s = readFileSync(f);
    assert.ok(!s.includes(SECRET) && !s.includes('cred-value-held-by-the-proxy-77'), `secret found in ${f}`);
  }
  // .stack-agent/ is written into the workspace by Stack-Agent but is not part of the diff
  assert.ok(statSync(join(r.runDir, 'workspace', '.stack-agent')).isDirectory());
  assert.doesNotMatch(readFileSync(join(r.runDir, 'artifacts', 'diff_agent.txt'), 'utf8'), /\.stack-agent/);
  const show = JSON.parse(readFileSync(join(r.runDir, 'agent', 'agent-state-show.json'), 'utf8'));
  assert.equal(show.task.task_id, runId, 'agent-state show captured for task id = runId');
});

test('stack-agent process-interruption: SIGKILL right after its first pax test, operator settlement, relaunch with the same task id resumes the task', async (t) => {
  await isolate(t);
  const lines = ['{"decision":"request_capability","capability":"project.read","inputs":{"path":"src/lib.rs"}}', ...FIX.slice(3)];
  const m = await startScriptedModel(t, ['{"decision":"request_capability","capability":"project.list","inputs":{"path":"."}}', ...lines]);
  const runId = 'sa-interrupt-1';
  const c = { ...course, doc: course.doc };
  const input = pendingRun({ runId, course: c, adapter: 'stack-agent', options: { leaseSecs: 6 }, model: model(m.url), obstacles: { enabled: true, overrides: { variant: 'interruption' } } });
  const r = await runDirect({ runId, input });
  const launches = JSON.parse(readFileSync(join(r.runDir, 'agent-result.json'), 'utf8')).launches;
  assert.ok(launches.length >= 2, `relaunched (${JSON.stringify(launches)})`);
  assert.equal(launches[0].signal, 'SIGKILL');
  assert.equal(launches[0].interrupted, true);
  const rec = r.result.recovery.find((x) => x.obstacleId === 'process-interruption');
  assert.equal(rec.injected, true);
  assert.equal(rec.recovered, true, rec.detail);
  assert.equal(r.result.metrics.interruptions, 1);
  assert.ok(['PASS', 'FAIL'].includes(r.result.outcome));
});

test('patch-agent: a genuinely different loop (orient, reproduce, diff, apply, verify) reaches PASS and recovers from the transient failure', async (t) => {
  await isolate(t);
  const diff = 'Here is the fix:\n```diff\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -8,5 +8,5 @@\n     if end < start {\n         return 0;\n     }\n-    (end - start) as u64\n+    (end - start) as u64 + 1\n }\n```\n';
  const up = await startFakeOpenAI(t, { replies: ['no diff here, sorry', diff] });
  const runId = 'patch-1';
  const r = await runDirect({ runId, input: pendingRun({ runId, course, adapter: 'patch-agent', model: model(up.url, { credentialRef: 'credential-ref:localmodel' }), obstacles: { enabled: true, overrides: { variant: 'transient-test-failure' } } }) });
  assert.equal(r.result.outcome, 'PASS');
  assert.equal(r.result.claims.agentSaysVerified, true);
  assert.equal(r.result.metrics.turns, 2, 'first reply had no diff; second one fixed it');
  assert.deepEqual(r.result.recovery.map((x) => [x.injected, x.recognized, x.recovered]), [[true, true, true]]);
  // the model saw the goal and file contents, never a credential; the upstream got the resolved credential from the proxy
  const bodies = JSON.stringify(up.seen.map((s) => s.body));
  assert.match(bodies, /span_len/);
  assert.ok(!bodies.includes(SECRET) && !bodies.includes('cred-value-held-by-the-proxy-77'));
  assert.equal(up.seen.at(-1).headers.authorization, 'Bearer cred-value-held-by-the-proxy-77');
});

test('patch-agent helpers', () => {
  assert.equal(extractDiff('```diff\n--- a/x\n+++ b/x\n```'), '--- a/x\n+++ b/x\n');
  assert.equal(extractDiff('nothing'), null);
  assert.ok(keywords('Fix span_len in src/lib.rs so that cargo test passes').includes('span_len'));
});
