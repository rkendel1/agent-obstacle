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
  evaluator/        independent acceptance: explicit evaluator resolution, the acceptance.v1 interpreter
                    (declarative.mjs), private evaluators, constraint checks, outcome classification
  preflight/        the release gate of a course version (npm run courses:preflight)
  courses/          course library on disk, digests, validation/pinning, fixture cache
courses/
  course-000-calibration/v2/   tiny Rust crate, real off-by-one defect; DECLARATIVE acceptance (no evaluator/),
                               public acceptance tests required unchanged, reference fix in reference/ (PAX can verify)
  course-001-ddmrv/v2/         T4 resolver defect on appport@268c9b4 (Discover, Diagnose, Modify, Recover, Verify);
                               PRIVATE evaluator (hidden test + reference from stack-agent, PROVENANCE.json)
  <course>/<version>/preflight.json   the passing preflight report the seed script publishes with course.json
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
npm run seed:courses                                  # publishes courses/*/*/course.json + preflight.json (never evaluator/)
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
  --run "course-000-calibration@v2=reference-control" \
  --run "course-000-calibration@v2=stack-agent:model=qwen2.5-coder-3b,endpoint=http://127.0.0.1:8080,obstacles=transient-test-failure" \
  --evidence-dir docs/harness/runs

# Stop
npm run harness:model:stop; npm run harness:authority:stop
```

Without the app (calibration, debugging): `npm run harness:run -- --course course-000-calibration/v2 --adapter
reference-control [--durable] [--evidence docs/harness/runs/x.json]` runs the same stages with a local sink
(result in the run directory); `--durable` also goes through the real work authority. `null-control` (the
unchanged base) is a harness-only control; the app's experiment form does not offer it.

Other commands: `npm run harness:test` (node:test; starts its own authorities on free ports and scripted
models), `npm run courses:validate|pin|prepare|export|list`, `npm run courses:preflight -- <course>/<version>`
(release gate; writes `preflight.json`), `npm run harness:status`, `npm run harness:clean -- --runs|--fixtures`.

### Course acceptance and the release gate

Every course declares its evaluator (`evaluator.kind`: `declarative` | `private` | `none`); there is no implicit
one. A declarative course's acceptance is an **acceptance.v1** spec — a finite set of check kinds (approved
commands as argv with bounded timeouts, exit status, files exist, content / structured-output matches, test
commands with parsed counts, final-state invariants, explicit `all`/`any`) that the harness interprets; it needs
no `evaluator/` directory. A private evaluator is a pinned directory whose digest is re-checked at evaluation.
`none`, a missing or invalid evaluator, or a changed evaluator / course document end the run ERROR
(`failureClass: "evaluator"`). A course version is published only with a passing **preflight**: fixture
reproducible, the unchanged fixture FAILS the declared checks, the reference PASSES all, every check executed,
required evidence captured, evaluator isolated and tamper-evident, cleanup works. Full reference:
[docs/courses/acceptance-v1.md](../courses/acceptance-v1.md).

| Course | Preflight baseline (unchanged fixture) | Preflight reference |
| --- | --- | --- |
| course-000-calibration/v2 (declarative) | FAIL: unit tests 1 passed / 1 failed, acceptance tests 1 / 2 | PASS: 2 / 0 and 3 / 0, every check passed |
| course-001-ddmrv/v2 (private, T4) | FAIL: hidden acceptance 2 passed / 6 failed, regression 1660 passed | PASS: hidden 8 / 0, regression 1660 passed |

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

**Credentials.** A model key resolves on the harness host from the experiment's `credential-ref:<id>`:

1. `FELTKIT_CREDENTIAL_<ID>` in the harness's environment always wins, and is the only source outside development.
2. In local development (the app on a loopback URL, and this checkout's `.feltkit/development` vault present), the
   key entered in **Studio → Models** (or `feltkit credential set`) is used: same machine, same user, same checkout,
   read through FeltKit's own vault code. `AOC_CREDENTIALS_DEV_VAULT=0` turns this off.

Run events record where the key came from, never the value. The per-run model proxy holds the value and sends it only
upstream; the agent gets a placeholder (`CHIP_API_KEY=local-placeholder`). Local models need no key. To use a key
that is not in Studio:

```bash
read -rs FELTKIT_CREDENTIAL_ANTHROPIC && export FELTKIT_CREDENTIAL_ANTHROPIC
```

Anthropic runs use the proxy's `anthropic` protocol: Stack-Agent speaks Messages (`--provider anthropic
--provider-profile anthropic`) to the per-run proxy, which forwards to `https://api.anthropic.com/v1/messages` (or
the experiment's endpoint) with the held key as `x-api-key`, and records usage for the log and the token budget.

## A run

`prepare` (course resolved by digest from `courses/`, course and experiment digests re-computed and checked,
the evaluator resolved explicitly, fixture from the cache, fresh workspace) → `observe-before` (PAX info/doctor/reality/drift) → `agent` (PAX shim on
PATH, per-run model proxy, adapter within budgets) → `observe-after` (PAX, diff excluding `.stack-agent/`, final tree
digest) → `evaluate` (evaluator and course digests re-checked; fresh tree = pristine fixture + the agent's diff;
declarative checks, or regression + hidden acceptance) → `report`
(`runs.completed`). Each stage is checkpointed in Durable Work; a reclaimed attempt (higher fencing token) skips
checkpointed stages. Stack-Agent's agent stage resumes the same task (`--task-id = runId`); other adapters restart
the stage from a reset workspace. Events and evidence are numbered/identified deterministically and resent safely.

Outcomes: PASS (acceptance pass, regression pass, no completed critical violation), FAIL (the agent ran and the
evaluator did not accept), BLOCKED (could not start for reasons outside the agent: environment not prepared, model
unavailable before any work), ERROR (harness/evaluator fault — including evaluator kind `none`, a
missing, invalid or tampered evaluator, an acceptance that could not be decided), CANCELLED. The agent's claim is
recorded in `claims` and never consulted; the outcome is classified from the acceptance record and harness state
only (never from `scoring`).

## What is enforced, detected, or not

| Constraint | Status | How |
| --- | --- | --- |
| Budgets (turns, executions, deadline, call timeout, output tokens) | enforced | passed to the agent as flags AND a harness wall clock (deadline + grace, process-group SIGTERM→SIGKILL) |
| Total-token budget | enforced when set | per-run proxy answers 429 after `model.inference.maxTotalTokens` (Stack-Agent has none of its own) |
| Host credentials | enforced | agent env is an allowlist (no `*_API_KEY`, `*TOKEN*`, `FELTKIT_CREDENTIAL_*`, `FELTDB_*`, proxy vars); tested |
| Evaluator files hidden | enforced by layout | private files (`evaluator/`, the reference fix) are never published, never copied into a workspace; acceptance runs in a separate tree; hidden step output stays on the harness host; leak-tested |
| Evaluator / acceptance tampering | detected (ERROR) | the course directory and the evaluator code are digested around the agent stage (critical violation), the private evaluator digest and the course digest are re-checked at evaluation, the app checks the reported provenance against the version |
| Unknown or unexecuted acceptance checks | enforced | acceptance.v1 is validated at publish and again before running; an unexecuted check is never a pass |
| Agent files influencing the evaluator | enforced | the evaluation tree is the pristine fixture + the agent's diff; ignored files (node_modules, target/, `.stack-agent/`) never reach it |
| Commits | detected (critical) | HEAD/refs vs the base |
| Planted acceptance file | detected (critical) | destination present in the workspace |
| Forbidden paths (manifests, lockfile, test config) | detected (major) | diff vs the base |
| Writes outside the workspace | partially detected | fixture cache + course evaluator dir digested before/after the agent stage; not a sandbox |
| Network | not enforced | proxy variables are not passed to the agent, nothing blocks a direct connection; not scored |
| "No public API change / no unrelated refactor" | not enforced | recorded via the diff for human review |

## Stack-Agent builds and A/B experiments

An experiment's `agent.options` (part of its digest) can select what Stack-Agent runs with:

| Option | Values | Effect |
| --- | --- | --- |
| `build` | a name in `harness/agents/stack-agent-builds.json` | run the binary built from that exact commit, installed at `${AOC_STACK_AGENT_BUILDS_DIR:-~/.aoc-bins}/stack-agent-<commit>`; absent: the harness's default binary |
| `contextProfile` | `replay`, `auto`, `light`, `standard`, `deep`, `recovery` | `--context-profile`; absent: the build's default |
| `promptCache` | `on`, `off` | `--prompt-cache`; absent: the build's default |
| `runLabel` | 1–64 of `A-Z a-z 0-9 . _ : -` | the arm label, passed with run/course/obstacle as `CHIP_RUN_LABELS` |

Rules: an unknown build, a missing binary, an invalid value, or an option the selected binary does not support
ends the run before the agent starts (environment) — nothing is silently dropped. Nothing is added to the command
line for an unset option, so existing experiments run exactly as before. The harness never builds or replaces a
binary. Every run records, in `reproducibility.agentBinary` and `reproducibility.agentConfig` and the
`config:agent` evidence item: the build, commit, path, sha256 and `--version`; the requested settings; the
**effective** settings from the agent's own report (`tuning.context_profile`, `generation.prompt_cache` and its
source, the run labels in its token ledger); its per-profile call counts and completion section. Metrics gain
`cacheReadTokens`, `cacheWriteTokens`, `uncachedInputTokens`, `totalInputTokens` from the agent's ledger — `null`
whenever any call did not report the field.

`npm run experiment:ab` reads a pre-registered plan (`experiments/ab-adaptive-context-v1.json`): with no flags it
checks the build and prints the exact experiment definitions, the ABBA run order, projected model calls and a cost
range; `--launch --stage <id> --confirm-paid` saves the experiments and launches the runs through the app.
`harness/test/stack-agent-config.test.mjs` validates the arms with local fake model servers (no paid calls).
Plans, results and the lessons learned so far are in [`experiments/`](../../experiments/README.md) — start with
[`experiments/LESSONS.md`](../../experiments/LESSONS.md).

## Known gaps

- **PAX now reads the T4 (pnpm → vitest) suite.** The pinned build (rkendel1/pax c70680c, still `pax 0.5.0`) reports
  `status: passed, reason: tests-passed` with counts (1,662 passed, 8 ignored at the base), so Stack-Agent can
  self-verify course-001. Earlier 0.5.0 builds reported `unsupported, interpretation-unsupported`; course-001@v2's
  document still describes that (it is immutable; the next version will update it). PAX `main` (aab5039) does not
  compile (the "mix" commit b0eddbd), so c70680c is the newest PAX build that does.
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

`docs/harness/runs/` holds small JSON summaries (no secrets, no prompt bodies). The course-000 and course-001
records below were made before v1.1 (declarative acceptance and preflight): their course digests and, for
course-000, the hidden-test acceptance they show are the previous documents'; the v1.1 baseline/reference numbers
are in the preflight table above and in each course's `preflight.json`. `*.app.json` went end to end through
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
| `course-000-calibration-v1.1-reference-control.app.json` | course-000 (v1.1, declarative) | reference-control (control) | PASS | 9/9 declarative checks executed and passed; the app accepted `reproducibility.evaluator` (declarative) and `acceptanceDigest` |
| `course-001-ddmrv-v1.1-reference-control.app.json` | course-001 (v1.1, private) | reference-control (control) | PASS | regression 1660 passed, hidden 8/8; private evaluator digest re-checked and accepted by the app |
