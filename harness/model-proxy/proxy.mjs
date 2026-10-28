// OpenAI-compatible model proxy in front of llama-cpp-python (productized from
// docs/integration/reference/shim/llm_shim.py).
//
//  * Rewrites response_format {type:"json_schema", json_schema:{schema:S}} (which llama-cpp-python
//    0.3.16 rejects with HTTP 500) into its {type:"json_object", schema:S}: grammar-constrained
//    decoding with the caller's real schema. mode "drop" removes response_format instead.
//  * Calls upstream NON-streaming (so usage is exact) and answers in the shape the caller asked
//    for: an SSE stream with a finish_reason chunk, a usage chunk and [DONE] (what Stack-Agent
//    requires), or one JSON body. An upstream that only streams (e.g. a scripted test model) is
//    accepted too: its SSE is assembled.
//  * Optional total-token budget (Stack-Agent has none): once spent, calls get HTTP 429.
//  * Holds the upstream credential (resolved by the harness from a credential reference); the
//    caller's Authorization header is never forwarded.
//  * Logs ONE metadata line per call: timing, sizes, usage, finish reason, status. Never request or
//    reply bodies (prompts can carry repository content; secrets must not reach logs).
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const chatUrl = (upstream) => {
  const u = upstream.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
};
const baseUrl = (upstream) => upstream.replace(/\/+$/, '').replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');

function parseSSE(text) {
  let content = '', finish = null, usage = null, model = null, id = null;
  for (const block of text.split(/\n\n/)) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    try {
      const obj = JSON.parse(data);
      model ??= obj.model; id ??= obj.id;
      for (const c of obj.choices ?? []) { content += c.delta?.content ?? ''; if (c.finish_reason) finish = c.finish_reason; }
      if (obj.usage) usage = obj.usage;
    } catch { /* ignore malformed frame */ }
  }
  return { id: id ?? 'chatcmpl-proxy', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish ?? 'stop' }], usage };
}

/**
 * @param {{upstream: string, log?: string, credential?: string, mode?: 'translate'|'drop',
 *          tokenBudget?: number, callTimeoutMs?: number, onCall?: (entry) => void, port?: number}} opts
 * @returns {Promise<{url: string, endpoint: string, port: number, stats: object, close: () => Promise<void>}>}
 */
export async function startModelProxy(opts) {
  const { upstream, log, credential, mode = 'translate', tokenBudget = null, callTimeoutMs = 3600_000, onCall, beforeReply, port = 0, host = '127.0.0.1' } = opts;
  const stats = { calls: 0, ok: 0, errors: 0, promptTokens: 0, completionTokens: 0, usageReported: 0, usageMissing: 0, budgetRefusals: 0 };
  const record = (entry) => {
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify(entry) + '\n'); }
    try { onCall?.(entry); } catch { /* observer errors never break the proxy */ }
  };
  const upstreamHeaders = { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        const r = await fetch(baseUrl(upstream) + req.url, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
        const data = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(data);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const n = ++stats.calls;
      const t0 = Date.now();
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"invalid JSON"}}'); return; }
      const wantsStream = body.stream === true;
      const rfIn = body.response_format;
      if (rfIn?.type === 'json_schema') {
        if (mode === 'drop') delete body.response_format;
        else body.response_format = { type: 'json_object', schema: rfIn.json_schema?.schema ?? {} };
      }
      body.stream = false; delete body.stream_options;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const entry = {
        n, start: new Date(t0).toISOString(), messages: messages.length,
        request_bytes: messages.reduce((a, m) => a + (typeof m.content === 'string' ? Buffer.byteLength(m.content) : 0), 0),
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null, stream: wantsStream,
        response_format_in: rfIn?.type ?? null, response_format_sent: body.response_format?.type ?? null,
      };
      if (tokenBudget != null && stats.promptTokens + stats.completionTokens >= tokenBudget) {
        stats.budgetRefusals++; stats.errors++;
        Object.assign(entry, { status: 429, error: 'token budget exhausted', secs: 0 });
        record(entry);
        res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'token budget exhausted (harness model proxy)', type: 'budget_exhausted' } }));
        return;
      }
      let out, status;
      try {
        const r = await fetch(chatUrl(upstream), { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(callTimeoutMs) });
        status = r.status;
        const text = await r.text();
        if (!r.ok) {
          stats.errors++;
          Object.assign(entry, { status, error: text.slice(0, 300), secs: (Date.now() - t0) / 1000 });
          record(entry);
          res.writeHead(status, { 'content-type': 'application/json' }).end(text);
          return;
        }
        out = (r.headers.get('content-type') ?? '').includes('event-stream') ? parseSSE(text) : JSON.parse(text);
      } catch (e) {
        stats.errors++;
        Object.assign(entry, { status: 502, error: `upstream: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`.slice(0, 300), secs: (Date.now() - t0) / 1000 });
        record(entry);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'upstream model server unavailable' } }));
        return;
      }
      const secs = (Date.now() - t0) / 1000;
      const choice = out.choices?.[0] ?? {};
      const text = choice.message?.content ?? '';
      const usage = out.usage ?? null;
      if (usage) { stats.usageReported++; stats.promptTokens += usage.prompt_tokens ?? 0; stats.completionTokens += usage.completion_tokens ?? 0; } else stats.usageMissing++;
      stats.ok++;
      Object.assign(entry, { status: 200, secs: Math.round(secs * 1000) / 1000, finish: choice.finish_reason ?? null, usage, reply_chars: text.length, tok_per_s: usage?.completion_tokens && secs ? Math.round((usage.completion_tokens / secs) * 100) / 100 : null });
      record(entry);
      try { await beforeReply?.(entry); } catch { /* observer errors never break the proxy */ }
      if (res.destroyed) return;
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: out.id ?? 'chatcmpl-proxy', object: 'chat.completion.chunk', model: out.model ?? body.model };
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
      sse({ ...base, choices: [], usage: usage ?? undefined });
      res.end('data: [DONE]\n\n');
    } catch (e) {
      stats.errors++;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'proxy error' } }));
      else res.end();
    }
  });
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  const url = `http://${host}:${actual}`;
  return {
    url, port: actual, endpoint: `${url}/v1/chat/completions`, stats,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
