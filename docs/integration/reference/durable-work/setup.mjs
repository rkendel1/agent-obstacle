// One-time bootstrap: keys, tenant, application, two mesh workers, grants.
// Writes state/config.json (contains secrets: local prototype only).
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, KEYS, NAMESPACE, cli, startServer } from './lib/server.mjs';
import { clientsFor, issueGrant, meshHeartbeat, nowSeconds } from './lib/feltdb-work.mjs';

rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

// 1. Service (application backend) key. Scope '*' includes authorization:grant,
//    tenant/application creation, workload:read. (Narrower scopes: see contract doc.)
const svcOut = cli('keys', 'create', '--keys', KEYS, '--name', 'aoc-app', '--scope', '*', '--namespace', NAMESPACE);
const service = { id: svcOut.match(/id: ([^)]+)\)/)[1], secret: svcOut.match(/fdb_live_\S+/)[0] };
console.log('service key id', service.id);

let server = await startServer();
let { authz, workers } = clientsFor(server.url, service.secret);

// 2. Tenant + application (control-plane routes, plain fetch; no SDK wrapper for these in WorkloadClient).
const post = async (path, body, tenantId) => {
  const r = await fetch(server.url + path, { method: 'POST', headers: { authorization: `Bearer ${service.secret}`, 'content-type': 'application/json', ...(tenantId ? { 'feltdb-tenant-id': tenantId } : {}) }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`); return j;
};
const tenant = await post('/api/tenants', { name: 'Agent Obstacle Course' });
const app = await post(`/api/tenants/${tenant.id}/applications`, { name: 'aoc' }, tenant.id);
console.log('tenant', tenant.id, 'app', app.id);
({ authz, workers } = clientsFor(server.url, service.secret, tenant.id));
const svcSubject = { kind: 'service', id: service.id };
const g = (subject, capabilities) => issueGrant(authz, { tenantId: tenant.id, appId: app.id, subject, capabilities });

// 3. Register two mesh workers (worker ids are assigned by the server).
const registration = await g(svcSubject, ['worker:register']);
const ws = [];
for (const name of ['aoc-worker-a', 'aoc-worker-b']) {
  const w = await workers.register({
    tenant_id: tenant.id, application_id: app.id, name, runtime: 'process', version: '1',
    capabilities: [], workload_kinds: ['aoc.attempt'], resource_profile: {}, labels: {},
    capacity: { concurrency: 1, active: 0 }, authorization_grant: registration, registered_by: svcSubject,
  });
  ws.push({ name, id: w.worker_id, capabilityVersion: w.capability_version });
  console.log('registered worker', name, w.worker_id, w.lifecycle);
}

// 4. Worker credentials: `keys create --worker <id>` makes a key that authenticates
//    AS that worker (subject {kind:'worker'}). The key store is read at server start,
//    so restart the server after creating them.
await server.stop();
for (const w of ws) {
  const out = cli('keys', 'create', '--keys', KEYS, '--name', w.name, '--scope', '*', '--namespace', NAMESPACE, '--worker', w.id);
  w.key = out.match(/fdb_live_\S+/)[0];
}
server = await startServer();
({ authz, workers } = clientsFor(server.url, service.secret, tenant.id));

// 5. Grants. Workers: claim + execute + mesh heartbeat. App: create, cancel, retry, read.
for (const w of ws) {
  w.grant = await g({ kind: 'worker', id: w.id }, ['worker:heartbeat', 'workload:claim', 'workload:execute']);
  const wc = clientsFor(server.url, w.key, tenant.id).workers;
  const hb = await meshHeartbeat(wc, w);
  console.log('worker heartbeat', w.name, hb.lifecycle, hb.health);
}
const grants = {
  create: await g(svcSubject, ['workload:create']),
  cancel: await g(svcSubject, ['workload:cancel']),
  retry: await g(svcSubject, ['workload:retry']),
};
const key = await authz.verificationKey();
await server.stop();

const config = { url: server.url, tenantId: tenant.id, appId: app.id, service, workers: ws, grants, verificationKey: key };
writeFileSync(join(STATE, 'config.json'), JSON.stringify(config, null, 2));
console.log('wrote state/config.json; grant verification key', key);
