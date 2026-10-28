// Process-group control. Every agent (and everything it starts: PAX, cargo, vitest) runs in its
// own session/process group (`detached: true` = setsid(2) on POSIX), so a kill reaches all of it.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sleep } from './util.mjs';

/** True if any process in group `pgid` is alive. */
export function groupAlive(pgid) {
  if (!pgid) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function killGroup(pgid, signal = 'SIGKILL') {
  if (!pgid) return false;
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

/** SIGTERM the group, wait `graceMs`, then SIGKILL; resolves when the group is gone (or after 10 s). */
export async function terminateGroup(pgid, { graceMs = 10_000 } = {}) {
  if (!groupAlive(pgid)) return { alreadyGone: true };
  killGroup(pgid, 'SIGTERM');
  const end = Date.now() + graceMs;
  while (Date.now() < end && groupAlive(pgid)) await sleep(100);
  let killed = false;
  if (groupAlive(pgid)) { killGroup(pgid, 'SIGKILL'); killed = true; }
  const end2 = Date.now() + 10_000;
  while (Date.now() < end2 && groupAlive(pgid)) await sleep(50);
  return { killed, gone: !groupAlive(pgid) };
}

/**
 * Spawn `cmd args` as the leader of a new process group. stdout/stderr go to files when paths are
 * given. `pidFile` records the pgid so a restarted worker can find and kill an orphaned group.
 * Returns { child, pgid, exited: Promise<{code, signal, durationMs}> }.
 */
export function spawnGroup(cmd, args, { cwd, env, stdoutPath, stderrPath, pidFile, stdin = 'ignore' } = {}) {
  const open = (p) => { if (!p) return 'pipe'; mkdirSync(dirname(p), { recursive: true }); return openSync(p, 'a'); };
  const out = open(stdoutPath); const err = open(stderrPath);
  const t0 = Date.now();
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [stdin, out, err] });
  if (typeof out === 'number') closeSync(out);
  if (typeof err === 'number') closeSync(err);
  if (pidFile && child.pid) { mkdirSync(dirname(pidFile), { recursive: true }); writeFileSync(pidFile, String(child.pid)); }
  const exited = new Promise((resolve) => {
    child.once('error', (e) => resolve({ code: null, signal: null, error: String(e.message), durationMs: Date.now() - t0 }));
    child.once('exit', (code, signal) => resolve({ code, signal, durationMs: Date.now() - t0 }));
  });
  return { child, pgid: child.pid, exited, startedAt: t0 };
}

/** Run a command to completion, capturing output (bounded by maxBuffer). Never throws on exit code. */
export function run(cmd, args, { cwd, env, timeoutMs = 600_000, input } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, input, killSignal: 'SIGKILL' });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : undefined, durationMs: Date.now() - t0 };
}

/** Async variant in its own process group with a wall-clock limit (group killed on timeout). */
export async function runGroup(cmd, args, { cwd, env, timeoutMs = 600_000, stdoutPath, stderrPath } = {}) {
  const p = spawnGroup(cmd, args, { cwd, env, stdoutPath, stderrPath });
  let stdout = '', stderr = '';
  p.child.stdout?.on('data', (d) => { stdout += d; });
  p.child.stderr?.on('data', (d) => { stderr += d; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(p.pgid, 'SIGKILL'); }, timeoutMs);
  const r = await p.exited;
  clearTimeout(timer);
  return { ...r, stdout, stderr, timedOut };
}
