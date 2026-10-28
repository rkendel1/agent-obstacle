# Agent Obstacle Course — harness

The harness is the app's AppPort client and the only component that runs agents. It holds no product
state: run lifecycle lives in Durable Work on a local `feltdb-server` 0.3.0, product records in the FeltKit app.
See `docs/ARCHITECTURE.md` and the contract `docs/contracts/harness-app.md`.

```
harness/
  work-authority/   local feltdb-server 0.3.0: setup/start/stop/status, secrets, tenant/app/workers, grants
  app-client/       thin AppPort client (POST /appport) + FakeApp (unit tests of harness logic only)
  dispatcher/       polls runs.pending / runs.cancellations, admits workloads (idempotency_key = runId), reconciles
  worker/           claim (fencing) → stages with a checkpoint after each → complete; heartbeats; cancel; resume
  agents/           adapters: stack-agent, patch-agent, reference-control, null-control
  model-proxy/      OpenAI-compatible proxy in front of llama-cpp-python (+ harness:model:start|stop)
  obstacles/        PAX shim (transient-test-failure, process-interruption), worker fault injection
  evidence/         PAX observations, workspace diff (excluding .stack-agent/), digests, evidence store
  evaluator/        independent acceptance + constraint checks + outcome classification
  courses/          course library on disk, digests, validation/pinning, fixture cache
courses/
  course-000-calibration/v1/   tiny Rust crate, real off-by-one defect, hidden test, reference fix (PAX can verify)
  course-001-ddmrv/v1/         T4 resolver defect on appport@268c9b4 (Discover, Diagnose, Modify, Recover, Verify)
```

## Running everything end to end

Prerequisites on this machine: Node 22 + pnpm 10, `feltdb-server` 0.3.0 at `/opt/feltdb/bin/feltdb-server`,
PAX 0.5.0 at `/root/.local/bin/pax`, `stack-agent` at `/home/user/stack-agent/target/release/stack-agent`,
llama-cpp-python in `/opt/llm/venv` with the Qwen2.5-Coder GGUFs in `/opt/llm/models` (all overridable:
`FELTDB_SERVER_BIN`, `AOC_PAX_BIN`, `AOC_STACK_AGENT_BIN`, `AOC_LLM_PYTHON`, `AOC_MODELS_DIR`).

```bash
npm ci
# 1. the app (FeltKit dev server). Port 3000 by default; any free port works.
npx feltkit dev --port 3100 --no-frontend &          # or: npm run dev
export FELTKIT_URL=http://127.0.0.1:3100
npm run seed:courses                                  # publishes courses/*/*/course.json (never evaluator/)
npm run harness:key -- --out .harness/harness-api-key # API key with role "harness" (0600 file)

# 2. the work authority (once; idempotent; leaves the server running)
npm run harness:authority:setup
npm run harness:authority:status                      # no secrets printed

# 3. a model (only for model-driven adapters)
npm run harness:model:start -- --model 3b             # llama-cpp-python :8080 + proxy :8081 (CPU; ~4.4 GB RAM)

# 4. the harness
export AOC_APP_URL=$FELTKIT_URL AOC_HARNESS_API_KEY=$(cat .harness/harness-api-key)
npm run harness:start                                 # long-running dispatcher + worker
#   or: npm run harness:once                          # until nothing is pending/running/waiting

# Launch runs from the UI (Configure → Launch), or scripted:
node scripts/harness-e2e.mjs --app $FELTKIT_URL --key-file .harness/harness-api-key \
  --run "course-000-calibration@v1=reference-control" \
  --run "course-000-calibration@v1=stack-agent:model=qwen2.5-coder-3b,endpoint=http://127.0.0.1:8080,obstacles=transient-test-failure" \
  --evidence-dir docs/harness/runs

# Stop
npm run harness:model:stop; npm run harness:authority:stop
```

Without the app (calibration, debugging): `npm run harness:run -- --course course-000-calibration/v1 --adapter
reference-control [--durable] [--evidence docs/harness/runs/x.json]` runs the same stages with a local sink
(result in the run directory); `--durable` also goes through the real work authority. `null-control` (the
unchanged base) is a harness-only control; the app's experiment form does not offer it.

Other commands: `npm run harness:test` (node:test; starts its own authorities on free ports and scripted
models), `npm run courses:validate|pin|prepare|export|list`, `npm run harness:status`, `npm run harness:clean --
--runs|--fixtures`.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `AOC_APP_URL`, `AOC_HARNESS_API_KEY` | — | the app (`POST $AOC_APP_URL/appport`) and its harness API key |
| `AOC_AUTHORITY_PORT` | 7791 | local feltdb-server |
| `AOC_HARNESS_STATE_DIR` | `.harness/` | authority data + `secrets.json` (0600) + fixture cache + model pids |
| `AOC_RUNS_DIR` | `~/.aoc/runs` | run directories (workspace, agent data, artifacts) — outside the repository |
| `AOC_MODEL_UPSTREAM` | `http://127.0.0.1:8080` | model server a run's proxy forwards to when the experiment has no `model.endpoint` |
| `AOC_WORKER` | `aoc-worker-a` | worker identity (`aoc-worker-b` also registered) |
| `AOC_LEASE_MS`, `AOC_POLL_MS`, `AOC_CONCURRENCY` | 15000, 3000, 1 | lease (heartbeat every lease/3), poll, parallel attempts |
| `FELTKIT_CREDENTIAL_<ID>` | — | value for `model.credentialRef = credential-ref:<id>` (hosted models only) |
| `AOC_FAULT_KILL` | — | drill: `<stage>:after` or `<stage>:<ms>` SIGKILLs the worker once (marker in the run dir) |

**Credentials.** Hosted-model keys for the harness come from the harness host's own environment
(`FELTKIT_CREDENTIAL_<ID>`, resolved from the experiment's `credential-ref:`). The app's encrypted vault
(`.feltkit/development/credentials.vault`, Studio → Models, `feltkit credential set`) is the app's custody; the
harness never reads it. The resolved value is held by the per-run model proxy and sent only upstream; the agent
gets a placeholder (`CHIP_API_KEY=local-placeholder`). Local models need no key.

For an Anthropic model (experiment `credential-ref:anthropic`), set the key in the shell that runs the harness
without putting it in your history, then start the harness:

```bash
read -rs FELTKIT_CREDENTIAL_ANTHROPIC && export FELTKIT_CREDENTIAL_ANTHROPIC
```

Anthropic runs use the proxy's `anthropic` protocol: Stack-Agent speaks Messages (`--provider anthropic
--provider-profile anthropic`) to the per-run proxy, which forwards to `https://api.anthropic.com/v1/messages` (or
the experiment's endpoint) with the held key as `x-api-key`, and records usage for the log and the token budget.

## A run

`prepare` (course resolved by digest from `courses/`, course and experiment digests re-computed and checked,
fixture from the cache, fresh workspace) → `observe-before` (PAX info/doctor/reality/drift) → `agent` (PAX shim on
PATH, per-run model proxy, adapter within budgets) → `observe-after` (PAX, diff excluding `.stack-agent/`, final tree
digest) → `evaluate` (fresh tree = pristine fixture + the agent's diff; regression + hidden acceptance) → `report`
(`runs.completed`). Each stage is checkpointed in Durable Work; a reclaimed attempt (higher fencing token) skips
checkpointed stages. Stack-Agent's agent stage resumes the same task (`--task-id = runId`); other adapters restart
the stage from a reset workspace. Events and evidence are numbered/identified deterministically and resent safely.

Outcomes: PASS (acceptance pass, regression pass, no completed critical violation), FAIL (the agent ran and the
evaluator did not accept), BLOCKED (could not start for reasons outside the agent: environment not prepared, model
unavailable before any work), ERROR (harness/evaluator fault), CANCELLED. The agent's claim is recorded in
`claims` and never consulted.

## What is enforced, detected, or not

| Constraint | Status | How |
| --- | --- | --- |
| Budgets (turns, executions, deadline, call timeout, output tokens) | enforced | passed to the agent as flags AND a harness wall clock (deadline + grace, process-group SIGTERM→SIGKILL) |
| Total-token budget | enforced when set | per-run proxy answers 429 after `model.inference.maxTotalTokens` (Stack-Agent has none of its own) |
| Host credentials | enforced | agent env is an allowlist (no `*_API_KEY`, `*TOKEN*`, `FELTKIT_CREDENTIAL_*`, `FELTDB_*`, proxy vars); tested |
| Evaluator files hidden | enforced by layout | only under `courses/**/evaluator/`; never published, never copied into a workspace; acceptance runs in a separate tree |
| Agent files influencing the evaluator | enforced | the evaluation tree is the pristine fixture + the agent's diff; ignored files (node_modules, target/, `.stack-agent/`) never reach it |
| Commits | detected (critical) | HEAD/refs vs the base |
| Planted acceptance file | detected (critical) | destination present in the workspace |
| Forbidden paths (manifests, lockfile, test config) | detected (major) | diff vs the base |
| Writes outside the workspace | partially detected | fixture cache + course evaluator dir digested before/after the agent stage; not a sandbox |
| Network | not enforced | proxy variables are not passed to the agent, nothing blocks a direct connection; not scored |
| "No public API change / no unrelated refactor" | not enforced | recorded via the diff for human review |

## Known gaps

- **PAX 0.5.0 cannot interpret the T4 (pnpm → vitest) suite**: `pax --json test` runs it (exit 0) but reports
  `status: unsupported, reason: interpretation-unsupported`, so Stack-Agent can never self-verify course-001 (no exit
  0). The evaluator scores independently; course-001's *Verify* dimension is `null`, never estimated.
- **Stack-Agent's capabilities are fixed** (10 compiled-in project operations); `work` has no AppPort discovery and no
  way to add capabilities — a course can only narrow them (`--kind inspect`).
- **`.stack-agent/` is always written into the workspace**; the harness excludes it (`.git/info/exclude` + diff
  pathspec) and evaluates from the pristine fixture.
- **No total-token budget in Stack-Agent**; only the harness proxy can enforce one. Usage from llama-cpp-python is
  restored by the proxy (non-streaming upstream).
- **Interruption semantics**: a SIGKILLed Stack-Agent holds its lease (`--lease-secs`, kept above the call timeout)
  and leaves an in-flight action with an unknown outcome; the harness waits the lease out and settles `pax.test`
  intents as operator from its PAX shim log (`agent-state settle`, recorded as a `recovery` event). Other unknown
  actions are left unsettled (the run then cannot resume, recorded honestly).
- **Small CPU models**: Qwen2.5-Coder 1.5B/3B at 5–9 tok/s on 4 cores; they are not expected to solve course-001.
- **Durable Work**: grants are 24 h and re-minted at harness start; a worker key cannot read a workload, so the
  dispatcher relays cancellations; leases have 1 s granularity. Single node only.
- **Course resolution**: the harness finds a course version by digest among its local `courses/`; the app's copy must
  be the same course.json (the seed script publishes it verbatim).

## Recorded runs

`docs/harness/runs/` holds small JSON summaries (no secrets, no prompt bodies). `*.app.json` went end to end through
the real FeltKit app (AppPort, harness API key) and Durable Work on feltdb-server 0.3.0; `*.local.json` went through
Durable Work with the local sink (`harness:run --durable`; null-control is harness-only).

| File | Course | Agent | Outcome | Notes |
| --- | --- | --- | --- | --- |
| `course-000-calibration-v1-reference-control.app.json` | course-000 | reference-control (control) | PASS | regression 2/2, hidden 3/3 |
| `course-000-calibration-v1-null-control.local.json` | course-000 | null-control (base) | FAIL | regression 1/2, hidden 1/3 |
| `course-001-ddmrv-v1-reference-control.app.json` | course-001 | reference-control (control) | PASS | regression 1660 passed, hidden 8/8 |
| `course-001-ddmrv-v1-null-control.local.json` | course-001 | null-control (base) | FAIL | regression 1660 passed, hidden 2/8 |
| `course-000-calibration-v1-stack-agent-qwen3b.app.json` | course-000 | stack-agent 0.1.0 + Qwen2.5-Coder-3B q4_k_m (CPU) | FAIL | 2 model calls, 1 read, then `escalated` without writing or running `pax test` (the transient obstacle was never triggered); claim recorded, not consulted |
| `course-000-calibration-v1-patch-agent-qwen3b.app.json` | course-000 | patch-agent + the same 3B | FAIL | recognized and recovered from the injected transient `pax test` failure, reproduced the failure, 3 patches that did not apply |
| `course-001-base-regression-determinism.json` | course-001 | — | — | the base regression ran 3/3 green; why integration-e2e is flaky |
