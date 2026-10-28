// Annotated client module: FeltDB Durable Work through the PUBLISHED contracts
// (@feltdb/core@0.15.0 WorkloadClient / WorkerClient / AuthorizationClient
//  against crates.io feltdb-server 0.3.0).
//
// Key facts this module encodes:
//  * `db.workloads` from createFeltDB() is `new WorkloadClient()` -> baseUrl '' and
//    plain fetch with credentials:'include'. In Node it cannot address the server
//    and carries no credential. Build your own WorkloadClient(baseUrl, fetcher).
//  * Authentication is a Bearer API key (`feltdb-server keys create ...`), injected
//    by a fetcher wrapper. The client merges `init.headers` *before* spreading
//    `...init`, so the wrapper must add its headers itself (it does below).
//  * Every Durable Work write ALSO carries a server-issued SignedGrant in the body:
//    create -> `authorization_snapshot` (cap workload:create, subject = caller),
//    claim/start/heartbeat/checkpoint/complete/fail/cancelled/context -> `grant`
//    (caps workload:claim + workload:execute, subject = {kind:'worker', id}),
//    cancel -> grant with workload:cancel, retry -> grant with workload:retry.
//  * Grants are minted by POST /v1/grants (AuthorizationClient.create) by a
//    principal with scope `authorization:grant` (or `*`). The server signs them with
//    ED25519 derived from FELTDB_GRANT_SIGNING_KEY; the grant must also be in the
//    server's grant store (verify_grant looks it up), so client-side signing is not
//    possible and the signing key must be stable across restarts.
import { WorkloadClient, WorkerClient, AuthorizationClient, FeltDBServiceError } from '@feltdb/core';

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** fetch wrapper that injects the bearer credential and tenant header. */
export function bearerFetch(token, tenantId) {
  return (url, init = {}) => fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      ...(tenantId ? { 'feltdb-tenant-id': tenantId } : {}),
    },
  });
}

/** All three published clients bound to one credential. */
export function clientsFor(baseUrl, token, tenantId) {
  const f = bearerFetch(token, tenantId);
  return {
    workloads: new WorkloadClient(baseUrl, f),
    workers: new WorkerClient(baseUrl, f),
    authz: new AuthorizationClient(baseUrl, f),
  };
}

/**
 * Mint a server-signed grant. `issuer` is overwritten by the server with the
 * caller's identity; `id` must be unique (duplicates -> GRANT_INVALID).
 */
export function issueGrant(authz, { tenantId, appId, subject, capabilities, ttlSeconds = 24 * 3600, id }) {
  const t = nowSeconds();
  return authz.create({
    contract_version: 1,
    id: id ?? `grant-${capabilities.join('+').replace(/[^a-z+]/g, '')}-${subject.id}-${t}-${Math.random().toString(36).slice(2, 8)}`,
    issuer: { kind: 'service', id: 'ignored-server-sets-this' },
    subject,
    tenant_id: tenantId,
    application_id: appId,
    capabilities,
    resources: [
      { kind: 'RESOURCE_PREFIX', uri: `flow://${appId}/workloads/*` },
      { kind: 'RESOURCE_PREFIX', uri: `flow://${appId}/workers*` },
    ],
    issued_at: t - 60,
    expires_at: t + ttlSeconds,
    parent_grant: null,
    revision: 1,
    status: 'ACTIVE',
  });
}

/** Body of a CreateWorkloadInput for one Agent Obstacle Course attempt. */
export function attemptRequest({ tenantId, appId, requester, createGrant, idempotencyKey, input }) {
  return {
    tenant_id: tenantId,
    application_id: appId,
    environment: 'local',
    definition_id: 'aoc.attempt',
    definition_revision: 'r1',
    trigger: 'user',
    input,
    requested_by: requester,             // server overwrites with the authenticated principal
    authorization_snapshot: createGrant, // subject MUST equal the authenticated principal
    capability_snapshot: [],             // must be a subset of the worker's granted capabilities
    idempotency_key: idempotencyKey,
    retry_policy: {
      max_attempts: 3,
      initial_delay_ms: 1000,
      max_delay_ms: 30_000,
      backoff: 'exponential',
      retry_on: ['timeout', 'worker_failure', 'transient_connection'],
    },
    // keys: queue_ms, claim_ms, execution_ms, heartbeat_ms, overall_ms (0 is rejected; omit = none)
    timeouts: { overall_ms: 600_000, heartbeat_ms: 30_000 },
  };
}

/** The fence every worker write carries. */
export const fenceOf = (workerId, claim, grant) => ({
  worker_id: workerId,
  claim_id: claim.claim_id,
  fencing_token: claim.fencing_token,
  grant,
});

/** Worker liveness heartbeat on the mesh (required: a worker must be READY+HEALTHY with free capacity to be placed). */
export function meshHeartbeat(workers, worker, active = 0) {
  return workers.heartbeat(worker.id, {
    worker_id: worker.id, version: '1', capability_version: worker.capabilityVersion,
    capacity: { concurrency: 1, active }, health: 'HEALTHY', timestamp: nowSeconds(), running_claims: [],
  }, worker.grant);
}

export const errInfo = e => e instanceof FeltDBServiceError
  ? { status: e.status, code: e.code, message: e.message }
  : { message: String(e?.message ?? e) };
