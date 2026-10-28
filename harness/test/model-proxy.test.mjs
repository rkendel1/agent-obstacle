import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startModelProxy } from '../model-proxy/proxy.mjs';
import { startFakeOpenAI } from './helpers.mjs';

const SECRET = 'sk-test-upstream-secret-1234567890';
const decisionSchema = { anyOf: [{ type: 'object', properties: { decision: { const: 'complete' } } }] };

test('proxy translates json_schema to json_object+schema, calls upstream non-streaming, emits SSE with usage, logs metadata only', async (t) => {
  const up = await startFakeOpenAI(t, { replies: ['{"decision":"complete","summary":"ok"}'] });
  const dir = mkdtempSync(join(tmpdir(), 'aoc-proxy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const p = await startModelProxy({ upstream: up.url, log, credential: SECRET });
  t.after(() => p.close());
  const res = await fetch(p.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-placeholder' }, body: JSON.stringify({
    model: 'm', stream: true, stream_options: { include_usage: true }, max_tokens: 64,
    messages: [{ role: 'system', content: 'PROMPT-BODY-MARKER rules' }, { role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { name: 'd', schema: decisionSchema, strict: false } } }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const sse = await res.text();
  assert.match(sse, /"finish_reason":"stop"/);
  assert.match(sse, /"usage":\{"prompt_tokens":120,"completion_tokens":30/);
  assert.match(sse, /data: \[DONE\]/);
  const sent = up.seen.at(-1);
  assert.deepEqual(sent.body.response_format, { type: 'json_object', schema: decisionSchema });
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.stream_options, undefined);
  assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, 'the proxy holds the credential; the agent placeholder is not forwarded');
  const entries = readFileSync(log, 'utf8');
  assert.doesNotMatch(entries, /PROMPT-BODY-MARKER|hello|decision/);
  assert.ok(!entries.includes(SECRET));
  const e = JSON.parse(entries.trim());
  assert.equal(e.response_format_in, 'json_schema'); assert.equal(e.response_format_sent, 'json_object');
  assert.deepEqual(e.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  assert.equal(p.stats.promptTokens, 120);
});

test('proxy answers JSON to non-streaming callers, accepts a streaming-only upstream, and enforces a total-token budget', async (t) => {
  const up = await startFakeOpenAI(t, { replies: ['diff --git a/x b/x'], stream: true });
  const p = await startModelProxy({ upstream: up.url, tokenBudget: 200 });
  t.after(() => p.close());
  const call = () => fetch(p.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) });
  const r1 = await call();
  assert.equal(r1.status, 200);
  const j = await r1.json();
  assert.equal(j.choices[0].message.content, 'diff --git a/x b/x');
  assert.equal(j.usage.completion_tokens, 30);
  assert.equal((await call()).status, 200);              // 300 tokens used after this call
  const r3 = await call();
  assert.equal(r3.status, 429, 'budget exhausted');
  assert.equal(p.stats.budgetRefusals, 1);
});

test('proxy reports an unreachable upstream as 502', async (t) => {
  const p = await startModelProxy({ upstream: 'http://127.0.0.1:1' });
  t.after(() => p.close());
  const r = await fetch(p.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m","messages":[]}' });
  assert.equal(r.status, 502);
});

test('anthropic protocol: forwards Messages with the held key as x-api-key, never the caller\'s, returns SSE unchanged, counts usage', async (t) => {
  const { createServer } = await import('node:http');
  const seen = [];
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{}"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join('\n\n') + '\n\n';
  const up = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization, version: req.headers['anthropic-version'], body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const dir = mkdtempSync(join(tmpdir(), 'aoc-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${up.address().port}`, protocol: 'anthropic', credential: 'sk-held-secret', log, tokenBudget: 200 });
  t.after(() => proxy.close());
  assert.match(proxy.endpoint, /\/v1\/messages$/);
  const call = () => fetch(proxy.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'local-placeholder', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), sse);
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].key, 'sk-held-secret');
  assert.equal(seen[0].auth, undefined);
  assert.equal(seen[0].version, '2023-06-01');
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual([proxy.stats.promptTokens, proxy.stats.completionTokens], [120, 7]);
  const line = readFileSync(log, 'utf8');
  assert.ok(!line.includes('sk-held-secret') && !line.includes('"hi"'));
  await call(); // 254 tokens now, over the budget of 200
  assert.equal((await call()).status, 429);
});
