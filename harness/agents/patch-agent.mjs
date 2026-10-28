// patch-agent: a deliberately simple ALTERNATIVE agent runtime with its own control loop, so the
// course can compare two genuinely different loops on the same model endpoint. It is not a
// Stack-Agent wrapper and makes no use of Stack-Agent's protocol.
//
// Loop (all inside the workspace):
//   1. orient: list tracked files (git ls-files), rank them by goal keywords (path + content hits),
//      read the top few within a byte budget;
//   2. reproduce: run `pax --dir . --json test` (through the PAX shim, so obstacles apply); a
//      PAX status "error" with a transient reason is retried (this is its recovery behaviour);
//   3. up to N iterations: ask the model for ONE unified diff (plain chat completion, no tools, no
//      structured output), apply it with `git apply --recount`, run `pax test`; stop on "passed";
//      on failure reset the tree to the base and feed the failure back;
//   4. claims: verified iff its last `pax test` after the last applied patch reported passed.
// Budgets: maxTurns = model calls, maxExecutions = pax test runs + patch applications, deadline.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnGroup, terminateGroup, run } from '../lib/proc.mjs';
import { tail, bounded, sleep } from '../lib/util.mjs';
import { emptyMetrics } from './adapter.mjs';

const STOP = new Set(['should', 'which', 'there', 'their', 'about', 'after', 'before', 'these', 'those', 'other', 'tests', 'test', 'passes', 'return', 'returns', 'change', 'commit', 'documented', 'behaviour', 'behavior', 'function', 'fails', 'failing', 'existing', 'directory', 'version', 'versions']);
export function keywords(goal) {
  const words = new Set();
  for (const m of goal.matchAll(/[A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9_]/g)) {
    const w = m[0];
    if (w.length < 4 || STOP.has(w.toLowerCase())) continue;
    if (/[_.]|[a-z][A-Z]/.test(w) || w.length >= 6) words.add(w);
  }
  return [...words].slice(0, 40);
}

export function extractDiff(text) {
  const fence = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/);
  let body = fence ? fence[1] : text;
  const start = body.search(/^(diff --git |--- )/m);
  if (start < 0) return null;
  body = body.slice(start);
  return body.endsWith('\n') ? body : body + '\n';
}

async function chat(req, messages, signal) {
  const b = req.budgets;
  const res = await fetch(req.model.endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-placeholder' },
    body: JSON.stringify({ model: req.model.model, messages, temperature: req.options?.temperature ?? 0, max_tokens: b.maxOutputTokens ?? 2048, stream: false }),
    signal: AbortSignal.any([AbortSignal.timeout(b.callTimeoutSecs * 1000), ...(signal ? [signal] : [])]),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`model HTTP ${res.status}`), { model: true, status: res.status });
  if ((res.headers.get('content-type') ?? '').includes('event-stream')) {
    let content = '';
    for (const line of text.split('\n')) { if (!line.startsWith('data:') || line.includes('[DONE]')) continue; try { for (const c of JSON.parse(line.slice(5)).choices ?? []) content += c.delta?.content ?? ''; } catch {} }
    return content;
  }
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

export const patchAgent = {
  id: 'patch-agent', control: false, needsModel: true, version: () => 'patch-agent-1.0',

  async run(req) {
    const t0 = Date.now();
    const b = req.budgets;
    const opts = { maxIterations: 3, maxFiles: 4, contextBytes: 24_000, ...req.options };
    const metrics = { ...emptyMetrics(), turns: 0, executions: 0, modelCalls: 0, paxTests: 0, writes: 0, reads: 0, modelFailures: 0 };
    const deadline = t0 + b.deadlineSecs * 1000;
    const cwd = req.workspace, env = req.env;
    const emit = (kind, summary, data) => req.emit({ source: 'agent', kind, summary, data });
    let cancelled = false, timedOut = false, verified = false, terminal = 'failed', summary = '';
    let currentGroup = null;
    const onAbort = () => { cancelled = true; if (currentGroup) terminateGroup(currentGroup, { graceMs: 2000 }); };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const out = () => ({
      adapter: 'patch-agent', version: 'patch-agent-1.0', control: false,
      claims: { agentTerminalState: cancelled ? 'cancelled' : terminal, agentSaysVerified: verified, summary: bounded(summary, 1024) },
      observed: { exitCode: cancelled ? null : verified ? 0 : 1, signal: null, durationMs: Date.now() - t0, timedOut, ...(cancelled ? { cancelled: true } : {}) },
      metrics, launches: [], observations: [], artifacts: [],
    });

    const paxTest = async () => {
      if (metrics.executions >= b.maxExecutions) throw Object.assign(new Error('executions limit reached'), { limit: true });
      metrics.executions++; metrics.paxTests++;
      const p = spawnGroup(req.paxBin, ['--dir', '.', '--json', 'test'], { cwd, env });
      currentGroup = p.pgid;
      let stdout = '', stderr = '';
      p.child.stdout.on('data', (d) => { stdout += d; }); p.child.stderr.on('data', (d) => { stderr += d; });
      const left = Math.max(1000, deadline - Date.now());
      const timer = setTimeout(() => terminateGroup(p.pgid, { graceMs: 2000 }), Math.min(left, 900_000));
      const r = await p.exited; clearTimeout(timer); currentGroup = null;
      let doc = null; try { doc = JSON.parse(stdout); } catch {}
      const res = { exit: r.code, status: doc?.status ?? 'unparsed', reason: doc?.reason ?? null, tests: doc?.tests ?? null, stderrTail: tail(stderr, 2500) };
      emit('tool.result', `pax test: ${res.status}${res.reason ? ` (${res.reason})` : ''}`, { status: res.status, reason: res.reason, tests: res.tests, exit: res.exit });
      return res;
    };
    const testWithRetry = async () => {
      let r = await paxTest();
      for (let i = 0; i < 2 && r.status === 'error' && /transient/.test(r.reason ?? '') && !cancelled; i++) {
        emit('recovery', 'pax test reported a transient infrastructure error; retrying', { attempt: i + 1 });
        await sleep(1000);
        r = await paxTest();
      }
      return r;
    };
    const resetTree = () => { run('git', ['checkout', '--', '.'], { cwd, env }); run('git', ['clean', '-fdq', '-e', '.stack-agent'], { cwd, env }); };

    try {
      // 1. orient
      const files = run('git', ['ls-files'], { cwd, env }).stdout.split('\n').filter((f) => f && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|Cargo\.lock)$/.test(f));
      const kw = keywords(req.objective.goal);
      const scored = [];
      for (const f of files) {
        let size = 0; try { size = statSync(join(cwd, f)).size; } catch { continue; }
        if (size > 200_000) continue;
        let text = ''; try { text = readFileSync(join(cwd, f), 'utf8'); } catch { continue; }
        if (text.includes('\u0000')) continue;
        let score = 0;
        for (const k of kw) { if (f.includes(k)) score += 5; const hits = text.split(k).length - 1; score += Math.min(hits, 5); }
        if (/\.(rs|ts|js|py|go|java)$/.test(f)) score += 1;
        if (/(^|\/)(test|tests|spec)\//.test(f)) score -= 1;
        if (score > 0) scored.push({ f, score, size });
      }
      scored.sort((a, b2) => b2.score - a.score || a.f.localeCompare(b2.f));
      const context = []; let bytes = 0;
      for (const s of scored) {
        if (context.length >= opts.maxFiles || bytes + s.size > opts.contextBytes) continue;
        context.push({ path: s.f, text: readFileSync(join(cwd, s.f), 'utf8') }); bytes += s.size; metrics.reads++;
      }
      emit('tool.call', `orient: ${files.length} tracked files; read ${context.map((c) => c.path).join(', ') || 'none'}`, { keywords: kw.slice(0, 12), read: context.map((c) => c.path) });

      // 2. reproduce
      let test = await testWithRetry();
      if (test.status === 'unsupported') emit('verification', 'PAX cannot interpret this project\'s tests (unsupported); patch-agent cannot verify its fix', { reason: test.reason });

      // 3. iterate
      let feedback = `Current test result: PAX status ${test.status}${test.reason ? ` (${test.reason})` : ''}.\n${test.stderrTail}`;
      for (let i = 1; i <= opts.maxIterations && !cancelled; i++) {
        if (metrics.turns >= b.maxTurns) { terminal = 'limit_reached'; summary = 'turn limit reached'; break; }
        if (Date.now() > deadline) { timedOut = true; terminal = 'limit_reached'; summary = 'deadline passed'; break; }
        const prompt = [
          `Goal:\n${req.objective.goal}`,
          `Relevant files (full contents):\n${context.map((c) => `=== ${c.path} ===\n${c.text}`).join('\n')}`,
          `Feedback:\n${feedback}`,
          'Reply with ONE unified diff in git format (--- a/path, +++ b/path, @@ hunks with exact context lines) that fixes the problem. Output only the diff.',
        ].join('\n\n');
        metrics.turns++; metrics.modelCalls++;
        emit('model.call', `iteration ${i}: asking the model for a patch`, { promptBytes: Buffer.byteLength(prompt) });
        let reply;
        try {
          reply = await chat(req, [{ role: 'system', content: 'You are a careful software engineer. You fix defects by writing minimal unified diffs.' }, { role: 'user', content: prompt }], req.signal);
        } catch (e) {
          if (cancelled) break;
          metrics.modelFailures++; terminal = 'failed'; summary = `model call failed: ${e.message}`; emit('model.call', summary, { failed: true }); break;
        }
        const diff = extractDiff(reply);
        if (!diff) { feedback = 'Your reply contained no unified diff. Reply with only a unified diff.'; emit('tool.result', 'reply contained no diff'); continue; }
        resetTree();
        if (metrics.executions >= b.maxExecutions) { terminal = 'limit_reached'; summary = 'executions limit reached'; break; }
        metrics.executions++;
        const ap = run('git', ['apply', '--recount', '--whitespace=nowarn', '-'], { cwd, env, input: diff });
        if (ap.code !== 0) { feedback = `Your patch did not apply: ${tail(ap.stderr, 800)}\nUse exact context lines from the files shown.`; emit('tool.result', 'patch did not apply', { error: tail(ap.stderr, 300) }); continue; }
        metrics.writes++;
        emit('file.change', `applied a patch (${diff.split('\n').length} lines)`, {});
        test = await testWithRetry();
        if (test.status === 'passed') { verified = true; terminal = 'completed'; summary = `fixed in ${i} iteration(s); pax test passed`; break; }
        if (test.status === 'unsupported') { terminal = 'unverified'; summary = 'patch applied; PAX reports the test suite as unsupported, so it could not be verified'; break; }
        feedback = `After your patch the tests still fail (PAX status ${test.status}). Output:\n${test.stderrTail}`;
        terminal = 'failed'; summary = `iteration ${i}: tests still failing`;
      }
    } catch (e) {
      if (e.limit) { terminal = 'limit_reached'; summary = e.message; }
      else if (!cancelled) throw e;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      if (currentGroup) await terminateGroup(currentGroup, { graceMs: 1000 });
    }
    return out();
  },
};
