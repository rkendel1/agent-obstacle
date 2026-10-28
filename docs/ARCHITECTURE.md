# Agent Obstacle Course — architecture (v1.0 MVP)

Each responsibility has one authoritative owner. The product exercises the released packages; it does not
reimplement them.

```
Browser (localhost:3000)          FeltKit Studio (dashboard: operator view of the same app)
   │  useQuery / useMutation
   ▼
FeltKit app  (feltkit/, @feltdb/feltkit)          ── product records: courses, course versions, experiments,
   │  AppPort capabilities (/appport, API key)        run projections, events, evidence index, evaluations
   ▼
Harness  (harness/, Node)                         ── dispatcher + worker + evaluator; no product state of its own
   │  WorkloadClient (published @feltdb/core 0.15.0)
   ├──▶ Work authority: feltdb-server 0.3.0       ── AUTHORITATIVE run lifecycle (Durable Work: admit, claim,
   │                                                 fence, checkpoint, complete, cancel, recover)
   ├──▶ Agent adapter → stack-agent (Chip)        ── the agent's control loop, decisions, tool execution
   │        └─ model: OpenAI-compatible endpoint (local llama.cpp via harness/model-proxy)
   ├──▶ PAX 0.5.0                                 ── observations and evidence (info/reality/drift, test results)
   └──▶ Evaluator (harness/evaluator)             ── independent acceptance; never trusts the agent's claim
```

## Who owns what

| Responsibility | Owner | Notes |
| --- | --- | --- |
| Course library, builder, experiments, comparison, reports, UI | FeltKit app (`feltkit/`, `src/`) | collections in the app's FeltDB |
| Run lifecycle (state, attempts, checkpoints, fencing, cancellation, recovery) | FeltDB Durable Work on `feltdb-server` 0.3.0 | the app stores a projection keyed by `workload_id`; the harness reconciles it from the authority |
| Model provider configuration | AppPort Services Intelligence (`feltkit model set`, Studio → Models) | an experiment records the selection it ran with (provider, model, endpoint, credential reference) |
| Secrets | host custody (FeltKit); only `credential-ref:` in any record | never in prompts, logs, evidence |
| Agent behaviour | Stack-Agent; other agents through adapters | no benchmark-only agent build |
| Evidence | PAX + harness capture (process, files, diffs) | unsupported checks stay unsupported |
| Acceptance | `harness/evaluator`, from the course version's acceptance section | the agent cannot read or change it |

The embedded runtime's `db.workloads` does not work (UPSTREAM: FeltDB F10), so Durable Work runs on a local
`feltdb-server`; see `docs/integration/durable-work.md`. The published release has no approval state, so nothing
in v1 needs one.

## Run flow

1. **Launch** (UI → `runs.launch` mutation): records a run projection `requested`, pinned to an immutable course
   version and a saved experiment definition (digest).
2. **Admit** (harness dispatcher): finds requested runs (`runs.pending`), admits one Durable Work workload per run
   (`definition_id: "aoc.attempt"`, `idempotency_key: runId`), records `workload_id` (`runs.admitted`).
3. **Execute** (harness worker): claims the workload (fencing token), then runs stages, checkpointing after each:
   `prepare` (isolated workspace from the course fixture; digests) → `observe-before` (PAX) → `agent` (adapter
   runs the agent within budgets; obstacle injected as the course defines) → `observe-after` (PAX, diff) →
   `evaluate` (independent acceptance in a separate copy) → `report`. Events stream to the app
   (`runs.events.append`).
4. **Complete**: the workload's result holds the outcome + metrics + evidence index; the app projection is updated
   (`runs.completed`). Outcome is one of PASS / FAIL / BLOCKED / ERROR / CANCELLED (README "Scoring").
5. **Recover**: if the worker dies, Durable Work expires its lease; the harness reclaims with a higher fencing
   token, reads checkpoints via `executionContext`, and resumes from the last completed stage (stages are
   idempotent). A stale worker is refused by the authority.
6. **Cancel** (UI → `runs.cancel`): the dispatcher cancels the workload; the worker's next fenced call is refused,
   it kills the agent's process group, confirms cancellation; outcome CANCELLED.

## Security and isolation

- Each attempt gets its own workspace directory outside this repository; the agent's working directory is that
  workspace only. Evaluator files (hidden acceptance, reference fixes) live in `harness/courses/**/evaluator/` and
  are never copied into the workspace. Acceptance runs in a fresh copy of the final workspace.
- The agent's environment is built from an allowlist: no host credentials (`OPENAI_API_KEY` and friends are
  removed), only the model endpoint and the course's configuration.
- Budgets (turns, executions, deadline, per-call timeout) are passed to the agent AND enforced by the harness
  (wall clock; process-group kill).
- Agent output and repository content are untrusted input: rendered as text, never executed by the app.
- If the environment cannot enforce a constraint, the course says so and does not score it.

See `docs/integration/stack-agent.md` for the agent contract and `docs/integration/durable-work.md` for the work
authority.
