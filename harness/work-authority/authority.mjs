// Local Durable Work authority: one feltdb-server 0.3.0 node (no --peer, no --worker), so it is
// implicitly the work authority. Data and secrets live under `.harness/` (gitignored).
//
//   .harness/secrets.json              0600  FELTDB_MASTER_KEY / SESSION_SECRET / GRANT_SIGNING_KEY (generated once, stable)
//   .harness/authority/feltdb.log      canonical log (+ siblings *.grants.json *.workers.json *.platform.json)
//   .harness/authority/api-keys.json   0600  key store (read at server start)
//   .harness/authority/state.json      0600  tenant/app ids, service + worker keys, grants
//   .harness/authority/server.{pid,log}
//
// Secrets are never printed or logged by this module.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, TOOLS } from '../lib/paths.mjs';
import { readJSON, writeJSON, randomSecret, sleep } from '../lib/util.mjs';
import { clientsFor, issueGrant, meshHeartbeat, grantExpiresAt, nowSeconds, errInfo } from './client.mjs';

export const NAMESPACE = 'aoc';
export const RELEASE = 'feltdb-server 0.3.0';
export const WORKER_NAMES = ['aoc-worker-a', 'aoc-worker-b'];

export function authorityPaths() {
  const root = stateDir();
  const dir = join(root, 'authority');
  return {
    root, dir, secrets: join(root, 'secrets.json'), data: join(dir, 'feltdb.log'), keys: join(dir, 'api-keys.json'),
    state: join(dir, 'state.json'), pid: join(dir, 'server.pid'), log: join(dir, 'server.log'),
  };
}
export const authorityPort = () => Number(process.env.AOC_AUTHORITY_PORT || 7791);
export const authorityUrl = () => `http://127.0.0.1:${authorityPort()}`;

/** Stable server secrets, generated once (0600). */
export function ensureSecrets() {
  const p = authorityPaths();
  if (existsSync(p.secrets)) {
    const mode = statSync(p.secrets).mode & 0o777;
    if (mode & 0o077) throw new Error(`${p.secrets} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
    return readJSON(p.secrets);
  }
  const s = { feltdbMasterKey: randomSecret(), feltdbSessionSecret: randomSecret(), feltdbGrantSigningKey: randomSecret(), createdAt: new Date().toISOString() };
  writeJSON(p.secrets, s, { mode: 0o600 });
  return s;
}

function serverEnv() {
  const s = ensureSecrets();
  // Only what the server needs; host credentials (OPENAI_API_KEY, …) are not passed.
  return { PATH: process.env.PATH, HOME: process.env.HOME, FELTDB_MASTER_KEY: s.feltdbMasterKey, FELTDB_SESSION_SECRET: s.feltdbSessionSecret, FELTDB_GRANT_SIGNING_KEY: s.feltdbGrantSigningKey };
}

const cli = (...args) => execFileSync(TOOLS.feltdbServer, args, { encoding: 'utf8', env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

function readPid() { const p = authorityPaths(); try { return Number(readFileSync(p.pid, 'utf8').trim()) || null; } catch { return null; } }
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export async function health(url = authorityUrl()) {
  try {
    const r = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String(e.message) }; }
}

/** Start the server as a detached daemon (pid file + log). Idempotent. */
export async function startAuthority({ timeoutMs = 30_000 } = {}) {
  const p = authorityPaths();
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const pid = readPid();
  if (alive(pid) && (await health()).ok) return { url: authorityUrl(), pid, already: true };
  const args = ['--host', '127.0.0.1', '--port', String(authorityPort()), '--namespace', NAMESPACE, '--data', p.data, '--keys', p.keys, '--auth'];
  const out = openSync(p.log, 'a');
  const child = spawn(TOOLS.feltdbServer, args, { env: serverEnv(), detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  writeFileSync(p.pid, String(child.pid));
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!alive(child.pid)) throw new Error(`feltdb-server exited during start; see ${p.log}`);
    if ((await health()).ok) return { url: authorityUrl(), pid: child.pid, already: false };
    await sleep(150);
  }
  throw new Error(`feltdb-server not ready after ${timeoutMs} ms; see ${p.log}`);
}

export async function stopAuthority({ signal = 'SIGTERM', timeoutMs = 15_000 } = {}) {
  const p = authorityPaths();
  const pid = readPid();
  if (!alive(pid)) { try { unlinkSync(p.pid); } catch {} return { stopped: false, reason: 'not running' }; }
  process.kill(pid, signal);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && alive(pid)) await sleep(100);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  while (alive(pid)) await sleep(50);
  try { unlinkSync(p.pid); } catch {}
  return { stopped: true, pid };
}

export function loadState() {
  const p = authorityPaths();
  if (!existsSync(p.state)) return null;
  return readJSON(p.state);
}

function createKey(name, extra = []) {
  const p = authorityPaths();
  const secretFile = join(p.dir, `.secret-${process.pid}-${Date.now()}`);
  const out = cli('keys', 'create', '--keys', p.keys, '--name', name, '--scope', '*', '--namespace', NAMESPACE, ...extra, '--secret-file', secretFile);
  const id = out.match(/id: ([^)]+)\)/)?.[1];
  const secret = readFileSync(secretFile, 'utf8').trim();
  rmSync(secretFile, { force: true });
  if (!id || !secret.startsWith('fdb_')) throw new Error('feltdb-server keys create: unexpected output');
  return { id, secret };
}

async function controlPost(url, token, path, body, tenantId) {
  const r = await fetch(url + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(tenantId ? { 'feltdb-tenant-id': tenantId } : {}) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${j.code ?? ''}`);
  return j;
}

/**
 * One-time bootstrap: service key, tenant, application, workers, worker keys (with the server
 * restart the key store needs), grants, mesh heartbeats. Idempotent: an existing complete setup is
 * kept (grants refreshed if close to expiry). `force` wipes the authority data first.
 * Leaves the server running.
 */
export async function setupAuthority({ force = false, log = () => {} } = {}) {
  const p = authorityPaths();
  ensureSecrets();
  const existing = loadState();
  if (existing?.complete && !force) {
    await startAuthority();
    const refreshed = await refreshGrants(existing, { log });
    log(`authority already set up (tenant ${existing.tenantId}, app ${existing.appId}); ${refreshed ? 'grants refreshed' : 'grants valid'}`);
    return loadState();
  }
  await stopAuthority();
  rmSync(p.dir, { recursive: true, force: true });
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });

  const service = createKey('aoc-harness-service');
  log(`service key ${service.id}`);
  await startAuthority();
  const url = authorityUrl();
  const tenant = await controlPost(url, service.secret, '/api/tenants', { name: 'Agent Obstacle Course' });
  const app = await controlPost(url, service.secret, `/api/tenants/${tenant.id}/applications`, { name: 'aoc' }, tenant.id);
  log(`tenant ${tenant.id}, application ${app.id}`);
  const { authz, workers } = clientsFor(url, service.secret, tenant.id);
  const svcSubject = { kind: 'service', id: service.id };
  const registration = await issueGrant(authz, { tenantId: tenant.id, appId: app.id, subject: svcSubject, capabilities: ['worker:register'] });
  const ws = [];
  for (const name of WORKER_NAMES) {
    const w = await workers.register({
      tenant_id: tenant.id, application_id: app.id, name, runtime: 'process', version: '1', capabilities: [],
      workload_kinds: ['aoc.attempt'], resource_profile: {}, labels: {}, capacity: { concurrency: 1, active: 0 },
      authorization_grant: registration, registered_by: svcSubject,
    });
    ws.push({ name, id: w.worker_id, capabilityVersion: w.capability_version });
    log(`registered worker ${name} ${w.worker_id}`);
  }
  // Worker keys authenticate AS the worker; the key store is read at start -> restart.
  await stopAuthority();
  for (const w of ws) w.key = createKey(w.name, ['--worker', w.id]).secret;
  await startAuthority();
  const state = { complete: false, url, namespace: NAMESPACE, release: RELEASE, tenantId: tenant.id, appId: app.id, service, workers: ws, grants: {}, createdAt: new Date().toISOString() };
  await refreshGrants(state, { force: true, log });
  state.complete = true;
  writeJSON(p.state, state, { mode: 0o600 });
  log('authority setup complete');
  return state;
}

/** Re-mint grants that expire within `marginSecs` (24 h grants; long-lived harnesses need this). */
export async function refreshGrants(state, { force = false, marginSecs = 6 * 3600, log = () => {} } = {}) {
  const soon = nowSeconds() + marginSecs;
  const stale = (g) => force || !g || grantExpiresAt(g) < soon;
  const needs = stale(state.grants.create) || stale(state.grants.cancel) || stale(state.grants.retry) || state.workers.some((w) => stale(w.grant));
  if (!needs) return false;
  const { authz } = clientsFor(state.url, state.service.secret, state.tenantId);
  const g = (subject, capabilities) => issueGrant(authz, { tenantId: state.tenantId, appId: state.appId, subject, capabilities });
  const svc = { kind: 'service', id: state.service.id };
  state.grants = { create: await g(svc, ['workload:create']), cancel: await g(svc, ['workload:cancel']), retry: await g(svc, ['workload:retry']) };
  for (const w of state.workers) {
    w.grant = await g({ kind: 'worker', id: w.id }, ['worker:heartbeat', 'workload:claim', 'workload:execute']);
    await meshHeartbeat(clientsFor(state.url, w.key, state.tenantId).workers, w);
  }
  if (state.complete !== false || force) writeJSON(authorityPaths().state, state, { mode: 0o600 });
  log('grants minted');
  return true;
}

/** Non-secret status summary. */
export async function authorityStatus() {
  const p = authorityPaths();
  const state = loadState();
  const pid = readPid();
  const h = await health();
  const out = { url: authorityUrl(), running: alive(pid), pid: alive(pid) ? pid : null, healthy: h.ok, setUp: !!state?.complete, release: RELEASE, dataDir: p.dir };
  if (state?.complete) {
    Object.assign(out, { tenantId: state.tenantId, appId: state.appId, workers: state.workers.map((w) => ({ name: w.name, id: w.id })), grantsExpireAt: new Date(Math.min(grantExpiresAt(state.grants.create), ...state.workers.map((w) => grantExpiresAt(w.grant))) * 1000).toISOString() });
    if (h.ok) {
      try {
        const { workloads } = clientsFor(state.url, state.service.secret, state.tenantId);
        const list = (await workloads.list(state.appId)).workloads ?? [];
        const byState = {};
        for (const w of list) byState[w.state] = (byState[w.state] ?? 0) + 1;
        out.workloads = byState;
      } catch (e) { out.listError = errInfo(e); }
    }
  }
  return out;
}
