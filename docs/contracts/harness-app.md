# Harness ↔ app contract (AppPort capabilities)

The harness is an AppPort client of the FeltKit app. It authenticates with an AppPort Services API key whose
roles are `["harness"]` (`services.apiKeys.roles`); it holds no other authority in the app. Every call is an
AppPort capability invocation (`POST /appport`, the FeltKit wire format) with an `idempotencyKey` on every
mutation. Discovery (`appport.discover` / the manifest) shows these capabilities; holding the `harness` role is
what authorizes them — discovering one grants nothing.

All payloads are JSON. Times are ISO-8601 strings. Sizes are bounded (a payload over the limit is refused, not
truncated silently). Secrets never appear: model credentials are `credential-ref:` strings only.

## Capabilities the app exposes to the harness

| Capability | Kind | Input | Output |
| --- | --- | --- | --- |
| `runs.pending@1` | query | `{ limit?: number }` | `{ runs: PendingRun[] }` — runs in state `requested` without a workload, oldest first |
| `runs.cancellations@1` | query | `{}` | `{ runs: { runId, workloadId }[] }` — cancel requested, not yet terminal |
| `courses.version@1` | query | `{ courseVersionId }` | `{ version: CourseVersion }` (immutable; includes `digest`) |
| `runs.admitted@1` | mutation | `{ runId, workloadId, workAuthority: { url, namespace, release } }` | `{ ok: true }` — idempotent; refuses a different workloadId for the same run |
| `runs.stage@1` | mutation | `{ runId, workloadId, attemptNumber, fencingToken, stage, status: "started"\|"completed"\|"failed", at, detail? }` | `{ ok: true }` |
| `runs.events.append@1` | mutation | `{ runId, events: RunEvent[] }` (≤ 200 per call) | `{ appended: number }` — idempotent on `(runId, seq)` |
| `runs.evidence.add@1` | mutation | `{ runId, items: EvidenceItem[] }` | `{ added: number }` — idempotent on `(runId, evidenceId)` |
| `runs.completed@1` | mutation | `RunResult` | `{ ok: true }` — idempotent; a second, different result for the same run is refused |

Not for the harness (role `admin` only; listed so that discovery is not mistaken for authority):

| Capability | Kind | Input | Output |
| --- | --- | --- | --- |
| `courses.publish@1` | mutation | `{ course: CourseDocument, digest?: string }` | `{ courseVersionId, ref, digest, created }` — idempotent on the document; a different document under a published `id@version` is refused |
| `models.environment.record@1` | mutation | `{ ready, source, provider?, model?, endpoint?, protocol?, credentialRef?, credentialPresent?, problems? }` | `{ ok: true, observationId }` — the environment's Intelligence selection as observed (`npm run model:sync`); never a secret |

```ts
type PendingRun = {
  runId: string; courseVersionId: string; courseDigest: string;
  experiment: ExperimentSnapshot;      // frozen copy of the saved experiment definition + its digest
  requestedAt: string; requestedBy: string;
};
type ExperimentSnapshot = {
  experimentId: string; digest: string;
  agent: { adapter: "stack-agent" | "patch-agent" | "reference-control"; version?: string; options?: Record<string, unknown> };
  model: { provider: string; model: string; endpoint?: string; credentialRef?: string; inference?: Record<string, unknown> } | null;
  budgets: { maxTurns: number; maxExecutions: number; deadlineSecs: number; callTimeoutSecs: number; maxOutputTokens?: number };
  obstacles: { enabled: boolean; overrides?: unknown };
  environment: { kind: "local-isolated" };
};
type RunEvent = {
  seq: number; at: string;
  source: "agent" | "runtime" | "pax" | "evaluator" | "harness";   // who asserts it
  kind: string;                         // e.g. "stage", "model.call", "tool.call", "tool.result", "file.change",
                                        // "obstacle.injected", "recovery", "budget", "claim", "verification"
  summary: string;                      // one line, untrusted text when source is "agent"
  data?: unknown;                       // bounded JSON
};
type EvidenceItem = {
  evidenceId: string; kind: "pax.observation" | "pax.test" | "diff" | "process" | "agent.report" | "acceptance" | "log" | "digest";
  label: string; source: RunEvent["source"]; digest: string;   // sha256 of content
  content?: string;                     // bounded text (≤ 256 KiB); larger artifacts are referenced by path + digest
  path?: string;                        // relative to the run's artifact directory on the harness host
};
type Outcome = "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "CANCELLED";
type RunResult = {
  runId: string; workloadId: string; outcome: Outcome;
  failureClass?: "agent" | "model" | "capability" | "environment" | "evaluator" | "harness";
  claims: { agentTerminalState?: string; agentSaysVerified?: boolean; summary?: string };   // what the agent claims
  observed: { exitCode?: number; signal?: string; durationMs: number; timedOut: boolean };    // what the runtime observed
  evaluation: {                                                                            // what the evaluator verified
    evaluatorVersion: string; acceptance: "pass" | "fail" | "not-run" | "error"; regression?: "pass" | "fail" | "not-run";
    checks: { id: string; result: "pass" | "fail" | "not-run" | "error"; detail?: string }[];
    violations: { id: string; severity: "critical" | "major" | "minor"; attempted: boolean; completed: boolean; detail: string }[];
  };
  metrics: Record<string, number | null>;   // null = not observed (never estimated)
  recovery: { obstacleId?: string; injected: boolean; recognized?: boolean | null; recovered?: boolean | null; detail?: string }[];
  reproducibility: { courseDigest: string; fixtureDigest?: string; finalTreeDigest?: string; experimentDigest: string;
                     agentVersion?: string; paxVersion?: string; evaluatorVersion: string; workAuthorityRelease?: string;
                     deterministic: boolean; note: string };
  startedAt: string; completedAt: string;
};
```

The app never accepts a `PASS` unless `evaluation.acceptance === "pass"` and no critical violation is completed;
it refuses an inconsistent result (defense in depth; the evaluator already applies this rule).

## Implementation notes (app v1.0) — binding details

These complete the contract above; the app implements exactly this (`feltkit/harness.ts`, tests in
`tests/harness.test.ts`).

### Wire format and authentication

`POST <app>/appport` (development: `http://localhost:3000/appport`), `Content-Type: application/json`,
`Authorization: Bearer <api key>`. Discovery: `GET /.well-known/appport`, manifest `GET /appport/manifest`.

```json
{ "protocol": "appport/1", "type": "request", "requestId": "<unique>",
  "capability": { "name": "runs.admitted", "version": 1 },
  "input": { "runId": "…", "workloadId": "…", "workAuthority": { "url": "…", "namespace": "aoc", "release": "feltdb-server 0.3.0" } },
  "idempotencyKey": "admit:<runId>" }
```

Response: `{ "type": "response", "requestId", "ok": true, "output": … }` or
`{ "ok": false, "error": { "code", "message", "details"? } }` (HTTP 200 either way).

- Every API key of this app holds exactly the role `harness` (`services.apiKeys.roles`). Development: create one with
  `npm run harness:key -- --out <file>` (as the dev admin, through AppPort Services' own API-key routes); it is
  shown once. Revoke in Studio → Services → API keys.
- `idempotencyKey` is for **mutations only**. Queries (`runs.pending`, `runs.cancellations`, `courses.version`)
  refuse one in development (`INVALID_REQUEST`, `IDEMPOTENCY_KEY_UNSUPPORTED`). Replaying a key returns the stored
  response without running the mutation again (durable across restarts). Independently of keys, every mutation is
  idempotent by its content as described below, so a retry with a new key is also safe.

### Errors

| Code | Meaning | Harness action |
| --- | --- | --- |
| `INVALID_INPUT` with `details.reason` | refused: the report contradicts what is recorded or breaks a rule | do not retry the same report; log it |
| `CONFLICT` | a concurrent write touched the same records (FeltDB commit fence); nothing was written | retry (bounded, with backoff) |
| `NOT_FOUND` (`details.reason: "unknown_run"`) | unknown run / course version | — |
| `PAYLOAD_TOO_LARGE` | a bound below was exceeded; nothing was written | split or shrink |
| `FORBIDDEN` / `UNAUTHORIZED` | the key lacks the permission / is invalid or revoked | — |

`details.reason` values: `workload_mismatch`, `not_admitted`, `invalid_state`, `stale_fencing_token`,
`run_terminal`, `invalid_time`, `invalid_json`, `duplicate_seq`, `invalid_digest`, `digest_mismatch`,
`no_content`, `evidence_conflict`, `result_conflict`, `course_digest_mismatch`, `experiment_digest_mismatch`,
`inconsistent_result` (with `details.problems`), `too_large`, `too_many_events`, `too_much_evidence`,
`too_many_stages`.

### Digests

`digest = "sha256:" + hex(sha256(utf8(canonicalJson(value))))`. Canonical JSON: object keys sorted by UTF-16 code
unit order (JavaScript's default `sort()`), no whitespace, arrays in order, strings and numbers exactly as
`JSON.stringify` writes them, `undefined` members omitted (RFC 8785 for integer/ordinary-decimal documents).
Course digest = over the whole course.json document; experiment digest = over
`{ agent, model, budgets, obstacles, environment }`. Inputs accept `sha256:<hex>` or bare 64-hex; outputs are always
`sha256:<hex>`. Evidence `digest` is `sha256` of the UTF-8 `content` when content is sent (checked), else of the
referenced file (not checked by the app).

```js
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
```

### Types not spelled out above

```ts
type CourseVersion = {
  courseVersionId: string; courseId: string; version: string; ref: string;   // ref = `${courseId}@${version}`
  status: "draft" | "published"; digest: string; publishedAt: string | null;
  spec: CourseDocument;                  // the course.json exactly as published (no evaluator files)
};
type CourseDocument = {                  // courses/<course>/<version>/course.json
  identity: { id: string /* lowercase slug */; version: string; name: string; description: string };
  objective: string | object; environment: unknown; capabilities: unknown; constraints: unknown; obstacles: unknown;
  acceptance: unknown; scoring: unknown; evidence: unknown; cleanup: unknown;   // object, array or string; shape owned by the harness
  meta: { skills: string[]; difficulty: string; kind: "deterministic" | "randomized" | "adversarial";
          expectedRuntimeSecs?: number; limits?: object; compatible?: unknown };
};
```

The Library shows, when present: `acceptance.summary` and `acceptance.checks` (ids or objects with `id`),
`scoring.dimensions`, `capabilities.tools`, `obstacles` (array, ids), `meta.limits`, `meta.compatible`.

`ExperimentSnapshot` conventions: `agent.options.capabilities` (string[]: the subset the agent may use),
`agent.options.recovery` (`{ allowRetry, maxRecoveries? }`), `agent.options.flags` (experimental flags);
`model.inference` (temperature, top_p, seed, …). `model` is `null` for `reference-control`. Secret values are
refused anywhere in a definition; only `credential-ref:` strings.

`RunResult`: the top level is strict (unknown keys refused); `claims`, `observed`, `evaluation`, check/violation/
recovery items and `reproducibility` accept additional fields. Suggested `metrics` keys (any number-or-null key is
accepted and compared): `modelCalls`, `toolExecutions`, `turns`, `inputTokens`, `outputTokens`, `totalTokens`,
`filesChanged`, `testsRun`, `costUsd`. `null` = not observed.

### Behaviour per capability

- `runs.pending`: `limit` 1–100 (default 20). Excludes runs with a cancel request. `courseDigest` and
  `experiment.digest` are the values the harness must reproduce/verify before running.
- `runs.admitted`: same `workloadId` again → `ok`; different → `workload_mismatch`. If a person cancelled the run
  **before admission**, the app has already made it terminal (`CANCELLED`, `cancelledBeforeAdmission`); a racing
  `runs.admitted` is still accepted and binds the workload, which then appears in `runs.cancellations` so the
  dispatcher cancels it; only a `CANCELLED` result is accepted for such a run.
- `runs.stage`: requires the bound `workloadId`. A replay of the same `(stage, status, attemptNumber, fencingToken)`
  → `ok`. A `fencingToken` lower than the highest recorded → `stale_fencing_token`. New stage reports after the
  result → `run_terminal`. `at` must be ISO-8601; `detail` ≤ 8 KiB JSON; ≤ 200 stage reports per run. The first
  stage report moves the projection to `running`.
- `runs.events.append`: ≤ 200 events per call, ≤ 20 000 per run, `summary` ≤ 2000 chars, `data` ≤ 16 KiB JSON,
  `kind` ≤ 64 chars. First write wins per `(runId, seq)`; `appended` counts only new events. The same `seq` twice
  in one call with different content → `duplicate_seq`. The UI reads events in `seq` order. Lanes:
  `source: "agent"` = Agent claims; `runtime | pax | harness` = Runtime observed; `evaluator` = Evaluator verified.
  Event kinds the Live Run screen counts: `model.call`, `tool.call`, `tool.result`, `file.change`, `failure`,
  `error`, `recovery`, `test`, `pax.test`, and `budget` with `data: { turnsUsed, executionsUsed }`.
- `runs.evidence.add`: ≤ 50 items per call, ≤ 2000 per run, `content` ≤ 256 KiB. Each item needs `content` or
  `path`. Same `(runId, evidenceId)` with the same digest → skipped; different digest → `evidence_conflict`.
- `runs.completed`: refused (`inconsistent_result`) when: `PASS` without `evaluation.acceptance === "pass"`;
  `PASS` with a completed critical violation; `PASS` with a `failureClass`; a violation `completed` but not
  `attempted`; `reproducibility.evaluatorVersion !== evaluation.evaluatorVersion`; a recovery entry recognized or
  recovered but not injected. Also refused: `workloadId` not the bound one, `courseDigest`/`experimentDigest` not the
  run's, `completedAt < startedAt`, result > 256 KiB. The identical result again → `ok`.

## Harness-side notes (harness v1.0) — what the client does

Added by the harness (`harness/`); nothing above is changed.

- **Course resolution.** The harness finds the course version to run by `courseDigest` among its local
  `courses/<id>/<version>/course.json` (digest as above) and cross-checks `courses.version@1`'s `digest`. A run whose
  digest matches no local course.json ends `ERROR` (`failureClass: "harness"`). It also re-computes the experiment
  digest over `{ agent, model, budgets, obstacles, environment }` and refuses a mismatch the same way.
- **Course document conventions the harness reads** (beyond the app's `identity`/`meta`): `objective.goal`,
  `objective.kind`; `environment.fixture` (`directory` or `git` with `repository`/`commit`/`install`, pinned
  `digest`); `capabilities.allowed`; `constraints[]` (`id`, `severity`, `enforcement`:
  `enforced|detected|partially-detected|not-enforced`, `paths`); `obstacles.default[]` and
  `obstacles.variants.<name>[]` (`type`: `transient-test-failure` | `process-interruption`); `acceptance`
  (`evaluatorDigest`, `install`, `recordOnly`, `regression.command`/`knownFlaky`, `hidden[]` with `file` under
  `evaluator/`, `dest`, `command`; `reference.file`); `meta.limits`.
- **Experiment conventions.** `obstacles: { enabled, overrides?: { variant } }` selects the course default or a
  named variant. `agent.options` is passed to the adapter (e.g. `leaseSecs`, `structuredOutput`, `temperature`,
  `maxIterations` for patch-agent). `model.endpoint` is the upstream the per-run harness proxy forwards to;
  `model.inference.maxTotalTokens` sets the proxy's token budget. `null-control` (the unchanged base) exists only
  in the harness (`harness:run`); the app's adapters are `stack-agent`, `patch-agent`, `reference-control`.
- **Reporting.** Stage reports `started|failed` for every stage and `completed` for every stage but `report`
  (the result is the report stage's completion; the app refuses stage reports after it). Events: `seq` per run,
  persisted before sending; `source: "harness"` for what the harness observed or did (model calls through its
  proxy, obstacle injections, recovery), `pax` for PAX observations and the agent's PAX results, `agent` for the
  agent's claim, `evaluator` for checks. Evidence ids are stable (`pax.observation:before`, `diff:agent`,
  `acceptance:verdict`, …). `metrics` keys: `agentDurationMs, turns, executions, modelCallsReported,
  modelCallsObserved, inputTokensReported, outputTokensReported, promptTokensObserved, completionTokensObserved,
  paxTestsObserved, paxTestsInjected, filesChanged, modelFailures, malformedReplies, interruptions,
  evaluationMs, attempts` (`null` = not observed). `recovery[]` entries: one per scheduled obstacle, plus
  `harness-worker-interruption` when a worker fault was injected and the attempt was reclaimed.
- **Work authority.** `runs.admitted.workAuthority = { url: "http://127.0.0.1:7791", namespace: "aoc",
  release: "feltdb-server 0.3.0" }`; one workload per run (`definition_id: "aoc.attempt"`, `idempotency_key: runId`).
