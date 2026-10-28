#!/usr/bin/env node
// npm run harness:model:start -- [--model 3b|1.5b|<path.gguf>] [--ctx 16384] [--threads 4]
// npm run harness:model:stop | harness:model:status
//
// Starts llama-cpp-python's OpenAI server (CPU) on AOC_LLM_PORT (8080) and the harness model proxy
// on AOC_MODEL_PROXY_PORT (8081). Pid files and logs: .harness/model/. The proxy log holds call
// metadata only. Runs started by the harness use their own per-run proxy in front of the upstream
// (AOC_MODEL_UPSTREAM, default http://127.0.0.1:8080); the standalone proxy on 8081 is for manual use.
//
//   node harness/model-proxy/cli.mjs serve --port 8081 --upstream http://127.0.0.1:8080 [--log f] [--mode drop]
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, TOOLS } from '../lib/paths.mjs';
import { sleep } from '../lib/util.mjs';
import { startModelProxy } from './proxy.mjs';

export const MODELS = {
  '3b': { file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf', alias: 'qwen2.5-coder-3b' },
  '1.5b': { file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', alias: 'qwen2.5-coder-1.5b' },
};
const dir = () => join(stateDir(), 'model');
const llmPort = () => Number(process.env.AOC_LLM_PORT || 8080);
const proxyPort = () => Number(process.env.AOC_MODEL_PROXY_PORT || 8081);
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const readPid = (f) => { try { return Number(readFileSync(join(dir(), f), 'utf8')) || null; } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const up = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };

function launch(name, cmd, args, env) {
  mkdirSync(dir(), { recursive: true });
  const out = openSync(join(dir(), `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd: dir(), detached: true, stdio: ['ignore', out, out], env });
  closeSync(out); child.unref();
  writeFileSync(join(dir(), `${name}.pid`), String(child.pid));
  return child.pid;
}

async function start() {
  const key = arg('model', process.env.AOC_MODEL || '3b');
  const m = MODELS[key] ?? { file: key, alias: basename(key).replace(/\.gguf$/, '') };
  const modelPath = m.file.startsWith('/') ? m.file : join(TOOLS.modelsDir, m.file);
  if (!existsSync(modelPath)) throw new Error(`model file not found: ${modelPath}`);
  const llmUrl = `http://127.0.0.1:${llmPort()}`;
  if (!(alive(readPid('llm.pid')) && (await up(`${llmUrl}/v1/models`)))) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8' };   // no host credentials
    const pid = launch('llm', TOOLS.llmPython, ['-m', 'llama_cpp.server', '--model', modelPath, '--model_alias', m.alias,
      '--host', '127.0.0.1', '--port', String(llmPort()), '--n_ctx', arg('ctx', '16384'), '--n_threads', arg('threads', '4'), '--chat_format', 'chatml'], env);
    writeFileSync(join(dir(), 'llm.json'), JSON.stringify({ pid, model: m.alias, path: modelPath, port: llmPort(), startedAt: new Date().toISOString() }, null, 2));
    const end = Date.now() + 180_000;
    while (!(await up(`${llmUrl}/v1/models`))) {
      if (!alive(pid)) throw new Error(`llama server exited; see ${join(dir(), 'llm.log')}`);
      if (Date.now() > end) throw new Error('llama server did not become ready in 180 s');
      await sleep(1000);
    }
    console.log(`[model] llama-cpp-python serving ${m.alias} at ${llmUrl} (pid ${pid})`);
  } else console.log(`[model] llama server already running at ${llmUrl}`);
  const proxyUrl = `http://127.0.0.1:${proxyPort()}`;
  if (!(alive(readPid('proxy.pid')) && (await up(`${proxyUrl}/v1/models`)))) {
    const pid = launch('proxy', process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(proxyPort()), '--upstream', llmUrl, '--log', join(dir(), 'proxy-calls.jsonl')], { PATH: process.env.PATH });
    const end = Date.now() + 15_000;
    while (!(await up(`${proxyUrl}/v1/models`))) { if (Date.now() > end || !alive(pid)) throw new Error('proxy did not start'); await sleep(200); }
    console.log(`[model] proxy at ${proxyUrl}/v1/chat/completions (pid ${pid}); call log ${join(dir(), 'proxy-calls.jsonl')}`);
  } else console.log(`[model] proxy already running at ${proxyUrl}`);
}

async function stop() {
  for (const f of ['proxy.pid', 'llm.pid']) {
    const pid = readPid(f);
    if (alive(pid)) { process.kill(pid, 'SIGTERM'); const end = Date.now() + 10_000; while (alive(pid) && Date.now() < end) await sleep(100); if (alive(pid)) process.kill(pid, 'SIGKILL'); console.log(`[model] stopped ${f.replace('.pid', '')} (pid ${pid})`); }
    try { unlinkSync(join(dir(), f)); } catch {}
  }
}

async function status() {
  let llm = null; try { llm = JSON.parse(readFileSync(join(dir(), 'llm.json'), 'utf8')); } catch {}
  const s = { llm: { running: alive(readPid('llm.pid')), ready: await up(`http://127.0.0.1:${llmPort()}/v1/models`), model: llm?.model ?? null, url: `http://127.0.0.1:${llmPort()}` },
    proxy: { running: alive(readPid('proxy.pid')), ready: await up(`http://127.0.0.1:${proxyPort()}/v1/models`), endpoint: `http://127.0.0.1:${proxyPort()}/v1/chat/completions` } };
  console.log(JSON.stringify(s, null, 2));
  process.exitCode = s.llm.ready && s.proxy.ready ? 0 : 1;
}

async function serve() {
  const p = await startModelProxy({ upstream: arg('upstream', 'http://127.0.0.1:8080'), port: Number(arg('port', '8081')), log: arg('log'), mode: arg('mode', 'translate') });
  console.log(`[proxy] listening ${p.endpoint}`);
  const shut = async () => { await p.close(); process.exit(0); };
  process.on('SIGTERM', shut); process.on('SIGINT', shut);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const f = { start, stop, status, serve }[cmd];
  if (!f) { console.error('usage: cli.mjs start [--model 3b|1.5b|path] | stop | status | serve --port P --upstream URL'); process.exit(2); }
  f().catch((e) => { console.error(`[model] ${e.message}`); process.exit(1); });
}
