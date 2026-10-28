# FeltDB Durable Work: contract for the Agent Obstacle Course run lifecycle

Proven against **published artifacts only**: crates.io `feltdb-server 0.3.0` (installed at `/opt/feltdb/bin/feltdb-server`, built from crate source with VCS sha `f9fe723`) and npm `@feltdb/core@0.15.0` (exact). Date: 2026-10-28.

Prototype dir: `docs/integration/reference/durable-work/`
- `lib/feltdb-work.mjs`: the annotated client module (clients, bearer fetcher, grant minting, request builder, fence helper)
- `lib/server.mjs`: server start/stop, flags and env
- `setup.mjs`: bootstrap (keys, tenant, app, workers, grants), writes `state/config.json`
- `worker.mjs`: a worker *process* that claims, resumes from checkpoints, heartbeats, checkpoints, completes, and honours cancellation
- `prototype.mjs`: the orchestrator with 32 assertions. Output is in `state/prototype.out`, `state/prototype.run2.out` and `state/results.json`.

Run it with `node setup.mjs && node prototype.mjs`. The prototype exits 0 with **32/32 PASS**. I ran it twice; the second run used the persisted state from the first.

---

## Verdict

**YES.** It can be the run lifecycle authority for a local, single-node product, under these conditions:

1. **One server node.** It must run with no `--peer`, so it is implicitly the Durable Work authority. Do not pass `--worker`; that flag turns on the in-process autonomous worker.
2. **Stable secrets across restarts.** Keep `FELTDB_MASTER_KEY` stable. Also set `FELTDB_GRANT_SIGNING_KEY` and keep it stable: grants are server-signed and verified on every call, and the default is a development string.
3. **Keep all the sibling files of `--data`** together, and back them up together: `*.log`, `*.grants.json`, `*.workers.json`, `*.platform.json`, plus the keys file. Workloads live in the canonical `feltdb.log`, but grants, the worker mesh and tenancy live in the JSON siblings.
4. **Workers are at-least-once.** After a lost lease the next attempt re-executes from the last committed checkpoint. A stage's side effects must be idempotent, or be committed through the checkpoint.
5. **The app does its own provisioning.** The npm package has no helper for minting keys, tenants or applications, or for registering workers. It is a one-time bootstrap (`setup.mjs`), plus one server restart after worker keys are created.

Every requirement passed against the published server: admission, idempotency, claim with fencing, start, heartbeat, staged checkpoints, completion with a result, SIGKILL of a worker with reclaim and resume from `executionContext().checkpoints`, stale-fence refusal, graceful restart, server SIGKILL with recovery after restart, cancellation, and list/inspect/history/result.

---

## 1. Server start

```bash
# install (done; ~10 min release build)
CARGO_INCREMENTAL=0 cargo install feltdb-server --version 0.3.0 --locked --root /opt/feltdb

export FELTDB_MASTER_KEY='aoc-local-master-key-change-me-0001'          # required; encrypts key store
export FELTDB_SESSION_SECRET='aoc-local-session-secret-at-least-32-bytes' # console sessions (>=32 bytes)
export FELTDB_GRANT_SIGNING_KEY='aoc-local-grant-signing-key-keep-stable' # ED25519 grant key = sha256(this); MUST stay stable

/opt/feltdb/bin/feltdb-server --host 127.0.0.1 --port 7791 --namespace aoc \
  --data  <state>/feltdb.log --keys <state>/api-keys.json --auth
# readiness: stdout line "FeltDB server ready at http://127.0.0.1:7791 (namespace: aoc)"
```

Flags (from `--help` of 0.3.0):
- `--host`, `--port`, `--advertise-url`, `--namespace`, `--data`, `--auth`, `--keys`, `--audit`, `--allow-origin`
- `--peer`, `--peer-token-env`, `--sync-interval-ms`
- `--worker`, `--work-authority`

How Durable Work is enabled:
- **No flag is needed.** In 0.3.0, `is_work_authority = --work-authority || cluster has no peers`, so a single node is the authority.
- `--work-authority` (or env `FELTDB_WORK_AUTHORITY=true`) is only for a peered cluster. Exactly one node may set it; two such nodes both refuse Durable Work writes with 421 `WORKLOAD_NOT_AUTHORITY`.
- `--worker` (or `FELTDB_WORKER_ENABLED=true`) starts the server's own autonomous worker loop. It is not needed for external workers, so leave it off.
- Lease-expiry recovery and deadline enforcement run every 1 s on the authority whatever the flags are (`start_workload_recovery`).

## 2. Setup (keys, tenant, app, workers): `setup.mjs`

1. **Service key (app backend).** Run this with the server stopped, or restart afterwards:
   `feltdb-server keys create --keys api-keys.json --name aoc-app --scope '*' --namespace aoc`
   - The output prints `(id: <keyId>)` and the secret `fdb_live_…`.
   - `--secret-file <path>` writes the secret to a 0600 file instead of stdout.
   - `--scope '*'` covers `authorization:grant` (minting grants), tenant/app creation and `workload:read`.
2. Start the server. `POST /api/tenants {name}` returns `{id: tenant_…}`. Then `POST /api/tenants/{tenant}/applications {name}` returns `{id: app_…}`. The creating key becomes the app's service principal, which `workload:read` (list/inspect/history/result) needs.
3. **Register workers.** First mint a `worker:register` grant (subject = the service). Then call `new WorkerClient(url, f).register({tenant_id, application_id, name, runtime:'process', version:'1', capabilities:[], workload_kinds:['aoc.attempt'], capacity:{concurrency:1}, authorization_grant, registered_by:{kind:'service', id:keyId}})`.
   - The server assigns `worker_id` (`worker_<hex>`) and `capability_version`.
4. **Worker credentials.** Stop the server, then run `feltdb-server keys create --keys api-keys.json --name aoc-worker-a --scope '*' --namespace aoc --worker <worker_id>`. That key authenticates as subject `{kind:'worker', id:<worker_id>}`. The key store is read at startup, so **restart the server**.
5. **Grants:** see section 3. Workers get `['worker:heartbeat','workload:claim','workload:execute']`; the app gets `workload:create`, `workload:cancel` and `workload:retry`.
6. **Mesh heartbeat.** Each worker calls `WorkerClient.heartbeat(id, {worker_id, version:'1', capability_version, capacity:{concurrency:1, active:0}, health:'HEALTHY', timestamp, running_claims:[]}, grant)`. A REGISTERED worker becomes READY and HEALTHY. Placement requires READY, HEALTHY and free capacity, and the definition_id must be in `workload_kinds` (empty kinds means any).

## 3. Grant issuance (SignedGrant) mechanics

- **Route:** `POST /v1/grants`, which is `new AuthorizationClient(url, f).create(grant)` from `@feltdb/core`. The caller needs scope `authorization:grant` (or `*`), and the response is 201 with a `SignedGrant`.
- **Signing:** `{algorithm:'ED25519-V1', key_id:'feltdb-primary-v1', grant, digest, signature}`.
  - The key is sha256 of `FELTDB_GRANT_SIGNING_KEY`, defaulting to `"feltdb-development-grant-key-change-me"`.
  - The public key is at `GET /v1/authorization/key` (`AuthorizationClient.verificationKey()`).
- **Grants are not bearer tokens you can mint yourself.** `verify_grant` checks the signature *and* looks the grant up in the server's store (`<data>.grants.json`), checking revocation. Only the server can issue them.
- **Offline alternative:** with the server stopped, `feltdb-server grant create --store <data>.grants.json --input grant.json` issues one with the same signing key.
- **Server-side rewrites:** the server overwrites `issuer` with the caller. `id` must be unique (a duplicate gives `GRANT_INVALID`). `expires_at > issued_at`, `status:'ACTIVE'`, `contract_version:1`, `parent_grant:null`.
- **Derived grants:** use `POST /v1/grants/{id}/delegate` (narrowing). Revoke with `POST /v1/grants/{id}/revoke`.

Grant body used (see `issueGrant` in `lib/feltdb-work.mjs`):
```js
{ contract_version:1, id:'<unique>', issuer:{kind:'service',id:'ignored'}, subject,
  tenant_id, application_id, capabilities:[...],
  resources:[{kind:'RESOURCE_PREFIX', uri:`flow://${appId}/workloads/*`},
             {kind:'RESOURCE_PREFIX', uri:`flow://${appId}/workers*`}],
  issued_at: now-60, expires_at: now+86400, parent_grant:null, revision:1, status:'ACTIVE' }
```

What each call checks. The grant subject must equal the **authenticated principal** (bearer key):

| Call | Body field | Capability | Subject |
|---|---|---|---|
| create | `authorization_snapshot` | `workload:create` on `flow://{app}/workloads` | the app's service key; also must equal `requested_by`/tenant/app, which the server sets to the caller |
| claim | `grant` | `workload:claim` | `{kind:'worker', id:worker_id}`; key must be a `--worker` key for that id |
| start/heartbeat/checkpoint/complete/fail/cancelled/context | `grant` (inside the fence) | `workload:execute` | the same worker |
| cancel | `{grant}` | `workload:cancel` | app service (a worker key with a worker grant gets 403) |
| retry | `{grant, reason?}` | `workload:retry` | app service |
| list/inspect/history/result | none | key must be an app principal with `workload:read` | worker keys get 404 (not 403, to prevent probing) |

## 4. Constructing WorkloadClient

- **`db.workloads` is a stub in Node.** `createFeltDB(...).workloads` is `new WorkloadClient()`, with baseUrl `''` and global fetch with `credentials:'include'`.
  - In Node it fails with `SERVICE_UNAVAILABLE` ("Failed to parse URL from /v1/workloads/…"). I verified this.
  - It never inherits `server.token`. Without credentials the server answers 401 `AUTHENTICATION_REQUIRED` (also verified).
- **Construct it yourself, one client per credential:**

```js
import { WorkloadClient, WorkerClient, AuthorizationClient } from '@feltdb/core';
const bearer = (token, tenantId) => (url, init = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, 'feltdb-tenant-id': tenantId } });
const app    = new WorkloadClient('http://127.0.0.1:7791', bearer(SERVICE_SECRET, TENANT));
const worker = new WorkloadClient('http://127.0.0.1:7791', bearer(WORKER_SECRET, TENANT));
```

Header handling: `WorkloadClient.json()` builds `{credentials, headers:{'content-type'}, ...init}`, so headers must be added by the fetcher wrapper. There is no header option on the client.

- **Errors** are `FeltDBServiceError` with `.status` and `.code`. The `.message` is often just the code; the body's `details` is on the error.
- A transport failure on a write gives `COMMIT_OUTCOME_UNKNOWN`. Retry the identical report (same fence and `result_id`); `complete` replays it.

## 5. Minimal API recipe

```js
// app: admit
const w = await app.create({ tenant_id, application_id, environment:'local', definition_id:'aoc.attempt',
  definition_revision:'r1', trigger:'user', input: attemptConfig, requested_by:{kind:'service', id:serviceKeyId},
  authorization_snapshot: createGrant, capability_snapshot: [], idempotency_key: `attempt-${attemptId}`,
  retry_policy:{max_attempts:3, initial_delay_ms:1000, max_delay_ms:30000, backoff:'exponential',
                retry_on:['timeout','worker_failure','transient_connection']},
  timeouts:{ overall_ms:600000, heartbeat_ms:30000 } });          // keys: queue_ms claim_ms execution_ms heartbeat_ms overall_ms; 0 rejected

// worker: claim -> context -> start -> (heartbeat/checkpoint)* -> complete
await workers.heartbeat(workerId, {worker_id:workerId, version:'1', capability_version, capacity:{concurrency:1,active:0},
                                   health:'HEALTHY', timestamp:now(), running_claims:[]}, workerGrant);   // mesh READY
const claim = await worker.claim(id, { worker_id: workerId, lease_ms: 5000, grant: workerGrant });
const fence = { worker_id: workerId, claim_id: claim.claim_id, fencing_token: claim.fencing_token, grant: workerGrant };
const ctx   = await worker.executionContext(id, fence);            // ctx.input, ctx.checkpoints (incl. lost attempts')
await worker.start(id, fence);
await worker.heartbeat(id, { ...fence, extend_ms: 5000 });         // new expires_at = now + extend_ms/1000
await worker.checkpoint(id, { ...fence, state: { stage:'setup', score:10 } });
await worker.complete(id, { ...fence, result_id:`result-${id}`, output, artifacts:[], schema_version:1 });
// on failure: worker.fail(id, {...fence, kind:'timeout'|'worker_failure'|..., error:'...', effect?:'none'|'unknown'})

// app: observe / control
await app.list(appId); await app.inspect(id); await app.history(id); await app.result(id);
await app.cancel(id, cancelGrant);  await app.retry(id, retryGrant, 'reason');
// worker sees cancel as WORKLOAD_TRANSITION_DENIED on checkpoint/complete -> worker.confirmCancelled(id, fence)
```

## 6. Observed state transitions (`execution_history`, actor in parentheses)

- **Happy path:**
  `CREATED->READY(rust)`, `READY->CLAIMED(worker-a)`, `CLAIMED->RUNNING`, `RUNNING->CHECKPOINTED`, `CHECKPOINTED->SUCCEEDED`
  - Only the first checkpoint produces a transition; later ones stay in CHECKPOINTED.
- **Worker SIGKILL and reclaim:**
  `… RUNNING->CHECKPOINTED(a)`, `CHECKPOINTED->RECOVERING(rust.recovery)`, `RECOVERING->READY(rust.recovery)`, `READY->CLAIMED(b)`, `CLAIMED->RUNNING(b)`, `RUNNING->CHECKPOINTED(b)`, `CHECKPOINTED->SUCCEEDED(b)`
- **Cancel while running:**
  `… CLAIMED->RUNNING(a)`, `RUNNING->CANCELLATION_REQUESTED(<service key>)`, `CANCELLATION_REQUESTED->CANCELLED(a)`
  - The worker confirms the cancellation. If the worker is dead instead, lease expiry turns CANCELLATION_REQUESTED into CANCELLED.
- **Cancel while READY:** `READY->CANCELLED(<service key>)` immediately.
- **Attempt statuses:** `CLAIMED`, `RUNNING`, `CHECKPOINTED`, `SUCCEEDED` / `WORKER_LOST` / `CANCELLED`.
- **Recovery evidence:** `{recovery_reason:'lease_expired', claim_id, worker_id, attempt_id, attempts_used, attempt_budget, lease_expired_at}`, then `{decision:'retry'|'attempt_budget_exhausted'|'worker_failure_not_retryable'}`. With no attempts left it goes to DEAD_LETTER.

## 7. Kill, reclaim and fencing results (all PASS)

**Worker A killed and reclaimed:**
- Worker A, a real OS process, was SIGKILLed right after checkpoint 2. The state stayed CHECKPOINTED until the lease ran out.
- The server recovered the work about 4.6 s after the kill (5 s lease; leases have 1 s granularity; the sweep runs every 1 s). Attempt 1 became `WORKER_LOST`.
- Worker B claimed with `fencing_token` 2 (A had 1).
- B's `executionContext().checkpoints` returned seq 1–2, produced by A in attempt 1. B skipped those stages, wrote seq 3 in attempt 2, and completed. `result.produced_by` = B.
- Attempts ended as `[WORKER_LOST, SUCCEEDED]`.

**A's credential and old fence, refused at every point:**
- After recovery but before the reclaim, a checkpoint gives **422 `WORKLOAD_CLAIM_INVALID`** (no active claim).
- While B holds the claim, checkpoint, complete and heartbeat each give **409 `WORKLOAD_STALE_FENCE`**. Nothing landed.
- A's credential presenting B's fence gives **403** (worker identity mismatch).

**Idempotency:**
- The same key with the same request gave the same `workload_id`, even with JSON members reordered.
- The same key with a different input gave **409 `CONFLICT`**, `details.reason = IDEMPOTENCY_KEY_REUSED`.
- `list` showed exactly one workload for the key.
- The idempotency scope is (tenant, app, requester, key).
- The server sets an `idempotent-replay: true` response header, but `WorkloadClient.create` does not expose it.

**Terminal state:** a SUCCEEDED workload's claim gives 422 `WORKLOAD_NOT_READY`, and a retry gives 409 `WORKLOAD_TRANSITION_DENIED`.

## 8. Restart results (all PASS)

- **Graceful SIGTERM and restart.** State, `execution_history`, attempts, checkpoints and result were byte-identical (sha256 of each), and `result()` returned the output. An idempotent create after the restart returned the same workload.
- **Server SIGKILL mid-attempt.** The worker was also killed after checkpoint 1, and the server stayed down 6.5 s (past the lease).
  - After restart, the recovery sweep moved the work to READY with `WORKER_LOST`.
  - Worker B read checkpoint 1 from the pre-crash attempt, resumed and completed.
- **Grants, worker registrations and keys survived both restarts.** The second full prototype run reused them all from disk.

## 9. Limitations and caveats (published 0.3.0 / 0.15.0)

**Client gaps:**
- No credential plumbing in the SDK for Durable Work: `db.workloads` is unusable server-side, so build `WorkloadClient(baseUrl, fetcher)` per credential.
- `WorkerClient` (MeshTransport) throws plain `Error`, not `FeltDBServiceError`.

**Provisioning is out-of-band:**
- Worker keys come only from the CLI `keys create --worker`, and the server needs a restart to load new keys.
- Worker IDs are server-assigned at register time, so the order is: register, then mint the key, then restart.

**Worker visibility:**
- A worker key cannot read the workload (404). It learns of cancellation only when a checkpoint or complete is refused with `WORKLOAD_TRANSITION_DENIED`, and must then call `confirmCancelled`.
- The heartbeat response does not report cancellation. Workers should checkpoint often, or the app must relay the cancel.

**Timing:**
- Leases and deadlines work in **whole seconds**: `expires_at = now + floor(lease_ms/1000)`, so a `lease_ms` below 1000 expires at once.
- Recovery can take up to about lease + 1 s. With retry_policy delays, lease-recovered work becomes READY immediately (`next_attempt_at` is not set on lease recovery).

**Mesh behaviour:**
- A mesh heartbeat *overwrites* `capacity.active` and `running_claims` with what the worker sends. Send the true values, or a busy worker can be placed twice.
- Mesh liveness (marking silent workers OFFLINE) is not run by the server, so there is no need for a periodic mesh heartbeat. The flip side is that the server never notices a silently dead worker except through workload leases.
- Every claim must name the workload id; there is no "claim next" route. The app or worker must poll `list` (app credential) and hand the id to a worker. Placement has an advisory route, `GET /v1/workloads/{id}/eligible-workers`.

**Semantics:**
- Execution is at-least-once; FeltDB does not know whether a lost attempt had side effects.
- `fail` accepts `effect: 'none'|'unknown'` to steer the retry decision.
- `result_id` is globally unique across workloads (`WORKLOAD_RESULT_DUPLICATE`). Use `result-${workloadId}`.
- `capability_snapshot` must be a subset of the worker's *granted* capabilities. `[]` is simplest.

**Security and operations:**
- The default grant-signing seed is a public development string. Set `FELTDB_GRANT_SIGNING_KEY`.
- Changing that key invalidates every stored grant. This is inferred from the code (signature verified against the current signer), not tested.
- Grants expire (`expires_at`). Long-lived workers need re-issued grants; the prototype uses 24 h.
- This setup is single-node only. A cluster needs exactly one `--work-authority` node; other nodes refuse writes with 421.

## 10. Published vs main differences

- **The published 0.3.0 server crate (sha `f9fe723`) has no approval lifecycle.**
  - `origin/main` adds commit `daf2446` "Durable Work: approval as an authority-gated lifecycle", merged at `5e72a9e`.
  - That commit adds states `AWAITING_APPROVAL` and `REJECTED`, the `approval` policy on create, `POST /v1/workloads/{id}/approve|reject` (capability `workload:approve`), and `WorkloadClient.approve/reject` in `packages/core`.
  - It touches about 1,000 lines across main.rs, workload.rs and workload.ts.
  - Neither npm 0.15.0 nor server 0.3.0 has any of it. Approval gating for AOC must be app-level until the next release.
- **npm 0.15.0 matches the published server.**
  - It has the same 15 workload routes, no approve/reject, and the same `WorkloadState` union (12 states).
  - `fail` has the `effect` field on the server; the client's `fail(id, input: unknown)` passes it through.
- **The local checkout `/home/user/flow_db` is not main.** It is on `claude/peaceful-gates-zhpb4h` at `e2f1928`, and is *older* than the published crate in places. Its server lacks:
  - `--work-authority` and the single-writer authority conflict guard (`WORKLOAD_NOT_AUTHORITY`)
  - fenced `fail` with `effect`
  - enforced `timeouts`/deadlines (`enforce_deadlines`, `WORKLOAD_TIMED_OUT`, `DEADLINE_CONTRACT_VERSION`)
  - `fresh()` authoritative reads
  - the `fields` list in the `IDEMPOTENCY_KEY_REUSED` details

  Its e2e `durable-work-lifecycle.test.mjs` still describes the published flow correctly, and was the model for this prototype.
- In 0.3.0, `timeouts` are **enforced** for newly admitted work (contract_version ≥ 2). Earlier builds stored them but ignored them, so set them deliberately: a too-small `heartbeat_ms`/`execution_ms` will time attempts out.

## 11. State at hand-off

- The server is stopped (verified: no process).
- `/opt/feltdb/bin/feltdb-server` is kept.
- The prototype state is in `durable-work/state/`. `config.json` there holds local-only secrets.
