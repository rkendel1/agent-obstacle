// FeltDB Durable Work through the PUBLISHED clients (@feltdb/core 0.15.0 against feltdb-server 0.3.0).
// See docs/integration/durable-work.md. Encoded facts:
//  * `db.workloads` is an unbound stub in Node; build WorkloadClient(baseUrl, fetcher) per credential.
//  * Auth is a Bearer API key + `feltdb-tenant-id`, injected by the fetcher (the client has no header option).
//  * Every write carries a server-issued SignedGrant (minted with POST /v1/grants by the service key).
import { WorkloadClient, WorkerClient, AuthorizationClient, FeltDBServiceError } from '@feltdb/core';

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const DEFINITION_ID = 'aoc.attempt';

export function bearerFetch(token, tenantId) {
  return (url, init = {}) => fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, ...(tenantId ? { 'feltdb-tenant-id': tenantId } : {}) },
  });
}

export function clientsFor(baseUrl, token, tenantId) {
  const f = bearerFetch(token, tenantId);
  return { workloads: new WorkloadClient(baseUrl, f), workers: new WorkerClient(baseUrl, f), authz: new AuthorizationClient(baseUrl, f) };
}

export function issueGrant(authz, { tenantId, appId, subject, capabilities, ttlSeconds = 24 * 3600 }) {
  const t = nowSeconds();
  return authz.create({
    contract_version: 1,
    id: `grant-${capabilities.join('+').replace(/[^a-z+]/g, '')}-${subject.id}-${t}-${Math.random().toString(36).slice(2, 8)}`,
    issuer: { kind: 'service', id: 'server-sets-this' },
    subject, tenant_id: tenantId, application_id: appId, capabilities,
    resources: [
      { kind: 'RESOURCE_PREFIX', uri: `flow://${appId}/workloads/*` },
      { kind: 'RESOURCE_PREFIX', uri: `flow://${appId}/workers*` },
    ],
    issued_at: t - 60, expires_at: t + ttlSeconds, parent_grant: null, revision: 1, status: 'ACTIVE',
  });
}

export const grantExpiresAt = (signed) => Number(signed?.grant?.expires_at ?? 0);

/** CreateWorkloadInput for one course attempt (one run). idempotency_key = runId. */
export function attemptRequest({ state, runId, input, overallMs, heartbeatMs = 120_000 }) {
  return {
    tenant_id: state.tenantId, application_id: state.appId, environment: 'local',
    definition_id: DEFINITION_ID, definition_revision: 'r1', trigger: 'user', input,
    requested_by: { kind: 'service', id: state.service.id },
    authorization_snapshot: state.grants.create, capability_snapshot: [],
    idempotency_key: runId,
    retry_policy: { max_attempts: 5, initial_delay_ms: 1000, max_delay_ms: 30_000, backoff: 'exponential', retry_on: ['timeout', 'worker_failure', 'transient_connection'] },
    timeouts: { overall_ms: overallMs, heartbeat_ms: heartbeatMs },
  };
}

export const fenceOf = (worker, claim) => ({ worker_id: worker.id, claim_id: claim.claim_id, fencing_token: claim.fencing_token, grant: worker.grant });

export function meshHeartbeat(workersClient, worker, active = 0) {
  return workersClient.heartbeat(worker.id, {
    worker_id: worker.id, version: '1', capability_version: worker.capabilityVersion,
    capacity: { concurrency: 1, active }, health: 'HEALTHY', timestamp: nowSeconds(), running_claims: [],
  }, worker.grant);
}

export const errInfo = (e) => e instanceof FeltDBServiceError
  ? { status: e.status, code: e.code, message: e.message }
  : { message: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}) };

export const isCode = (e, ...codes) => codes.includes(errInfo(e).code);

export const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER', 'TIMED_OUT', 'REJECTED']);

/** The app (service) and one worker's clients, from the persisted authority state. */
export function authorityClients(state, workerName) {
  const app = clientsFor(state.url, state.service.secret, state.tenantId);
  const worker = workerName ? state.workers.find((w) => w.name === workerName) : state.workers[0];
  if (!worker) throw new Error(`no registered worker named ${workerName}`);
  const wc = clientsFor(state.url, worker.key, state.tenantId);
  return { app: app.workloads, appAuthz: app.authz, worker, workerWorkloads: wc.workloads, workerMesh: wc.workers };
}
