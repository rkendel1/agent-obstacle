#!/usr/bin/env node
// PAX shim: installed first on the agent's PATH (and as PAX_BIN) as `pax`.
//   node pax-shim.mjs --aoc-config <config.json> -- <pax args...>
// config: { realPax, log, testFailures: { failFirst, exitCode, obstacleId } | null }
//
// Every invocation is logged (args, operation, exit, parsed PAX status/reason/tests, duration) to
// config.log — this is how the harness observes the agent's own `pax test` results. When the
// course schedules `transient-test-failure`, the first `failFirst` `test` invocations do NOT run
// the tests: they print a valid pax.execution-result.v1 with status "error" and reason
// "transient-infrastructure-failure", explain on stderr that this is a transient infrastructure
// fault, and exit with `exitCode` (75, EX_TEMPFAIL). Later invocations delegate to the real PAX
// unchanged. The shim never alters a real PAX result.
import { readFileSync, appendFileSync, mkdirSync, rmdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const ci = argv.indexOf('--aoc-config');
const config = JSON.parse(readFileSync(argv[ci + 1], 'utf8'));
const sep = argv.indexOf('--');
const args = sep >= 0 ? argv.slice(sep + 1) : argv.slice(ci + 2);

const VALUED = new Set(['--dir', '--tool', '--scope', '--max-files', '--max-bytes', '--max-facts']);
function operation(a) {
  for (let i = 0; i < a.length; i++) {
    if (VALUED.has(a[i])) { i++; continue; }
    if (a[i].startsWith('-')) continue;
    return a[i];
  }
  return null;
}
const op = operation(args);
const json = args.includes('--json');

// Serialize the count of `test` invocations with a lock directory (agents may run PAX concurrently).
function withLock(fn) {
  const lock = config.log + '.lock';
  for (let i = 0; i < 400; i++) {
    try { mkdirSync(lock); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}
const countTests = () => { try { return readFileSync(config.log, 'utf8').split('\n').filter((l) => l.includes('"op":"test"') && l.includes('"phase":"start"')).length; } catch { return 0; } };
const log = (entry) => { mkdirSync(dirname(config.log), { recursive: true }); appendFileSync(config.log, JSON.stringify(entry) + '\n'); };

// process-interruption obstacle with a `pax.test` trigger: right after the Nth `pax test` finishes,
// SIGKILL the whole process group (the agent and everything it started) before the agent can read
// the result. Deterministic: the point is defined by the course, and fires once (marker file).
function maybeInterrupt(n) {
  const it = config.interrupt;
  if (!it || n == null || n < it.afterTests || existsSync(it.marker)) return;
  writeFileSync(it.marker, new Date().toISOString());
  log({ op: 'interrupt', n, obstacleId: it.obstacleId, at: new Date().toISOString() });
  process.kill(0, 'SIGKILL');
}

const t0 = Date.now();
let ordinal = null, inject = false;
if (op === 'test') {
  withLock(() => {
    ordinal = countTests() + 1;
    const tf = config.testFailures;
    inject = !!tf && ordinal <= (tf.failFirst ?? 0);
    log({ n: ordinal, op: 'test', phase: 'start', at: new Date(t0).toISOString(), args, injected: inject, ...(inject ? { obstacleId: tf.obstacleId } : {}) });
  });
}

if (inject) {
  const tf = config.testFailures;
  const exitCode = tf.exitCode ?? 75;
  const result = { schema: 'pax.execution-result.v1', operation: 'test', status: 'error', reason: 'transient-infrastructure-failure', tool: null, exit_code: null };
  process.stderr.write(`pax: TRANSIENT INFRASTRUCTURE FAILURE (injected by the Agent Obstacle Course harness, obstacle "${tf.obstacleId}", test invocation ${ordinal} of the first ${tf.failFirst}): the test runner could not be started. No tests ran; this is not a result about the code. Retrying the same command may succeed.\n`);
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  log({ n: ordinal, op: 'test', phase: 'end', injected: true, obstacleId: tf.obstacleId, exit: exitCode, status: 'error', reason: result.reason, ms: Date.now() - t0 });
  maybeInterrupt(ordinal);
  process.exit(exitCode);
}

const child = spawn(config.realPax, args, { stdio: ['inherit', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.on('error', (e) => { log({ n: ordinal, op, phase: 'end', error: String(e.message), ms: Date.now() - t0 }); process.exit(127); });
child.on('close', (code, signal) => {
  let parsed = null;
  if (json) { try { const r = JSON.parse(out); parsed = { schema: r.schema, status: r.status ?? r.outcome ?? null, reason: r.reason ?? null, tool: r.tool ?? null, tests: r.tests ?? null }; } catch { parsed = { unparsed: true }; } }
  if (op === 'test') { log({ n: ordinal, op: 'test', phase: 'end', injected: false, exit: code, signal, ...parsed, ms: Date.now() - t0 }); maybeInterrupt(ordinal); }
  else log({ op, args, at: new Date(t0).toISOString(), exit: code, signal, ...(parsed ? { status: parsed.status } : {}), ms: Date.now() - t0 });
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
