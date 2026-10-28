# Stack-Agent (Chip) harness integration contract

Established 2026-10-28 on this machine (4 vCPU Xeon @ 2.1 GHz with AVX-512, 15 GB RAM, no GPU), from source
and from real runs. Audience: the "Agent Obstacle Course" harness. Everything under "measured" or with a run path was
executed. Everything else is cited from source (paths are relative to `/home/user/stack-agent`).

Scratch evidence: `<local scratch>/runs/` (one directory per
run: `report.out`, `stderr.log`, `exit.txt`, `agent.diff`, `git-status.txt`, `state-files.txt`, `shim-calls.jsonl`),
plus helper scripts in `.../scratchpad/shim/`.

---

## 1. Build and versions

| Item | Value |
| --- | --- |
| Source | `/home/user/stack-agent` @ `96fa787230556eea81d158d9c31f0ecc19d127a0` (main, "Merge pull request #75 … hard-task-bakeoff"); tracked files untouched (`git status` is clean) |
| Toolchain | `rust-toolchain.toml` pins `1.97.0`. Rustup cannot download it (static.rust-lang.org fails TLS through the proxy), but the installed `stable` **is** 1.97.0, so set `RUSTUP_TOOLCHAIN=stable` |
| Build command | `cd /home/user/stack-agent && RUSTUP_TOOLCHAIN=stable CARGO_INCREMENTAL=0 cargo build --locked --release --bin stack-agent` (9 min 12 s; `target/` is 519 MB) |
| Binary | `/home/user/stack-agent/target/release/stack-agent`, 25.6 MB, sha256 `98a579cffa31e2cc20033a2f92381cb137d9a17fd39e5161f1ae71fefebc74b7` |
| `stack-agent --version` | `stack-agent 0.1.0` (exit 0) |
| `stack-agent --test` | prints `Chip / FX provider: test / Turn completed / Hello from the test provider.` (exit 0) |
| `stack-agent --help`, `work --help` | exit 0. Full text: `scratchpad/logs/help.txt`, `scratchpad/logs/work-help.txt` |
| `stack-agent doctor` | exit 3 with no model selected. With a model and endpoint set, every row is `ok`. It checks the binary, model selection, a TCP connect to the endpoint (no request), git, project, pax, verification (Cargo.toml present?) and the state directory. Output: `scratchpad/logs/doctor.txt` |
| PAX | `/root/.local/bin/pax`, `pax 0.5.0` (built from `/home/user/pax` @ `c3fb3b4`). Put `/root/.local/bin` on `PATH`, or set `PAX_BIN` |

## 2. The command a harness runs

```bash
cd "$TASK_CHECKOUT"            # the project root: work ALWAYS operates on the current directory
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  PATH=/root/.local/bin:$PATH \
  CHIP_API_KEY=local-placeholder \
  STACK_AGENT_DATA_DIR="$RUN/data" \
  CARGO_TARGET_DIR="$RUN/target" CARGO_INCREMENTAL=0 \
  /home/user/stack-agent/target/release/stack-agent work "$(cat goal.txt)" \
    --kind change \
    --provider openai-compatible --model qwen2.5-coder-3b \
    --endpoint http://127.0.0.1:8081/v1/chat/completions \
    --provider-profile local --structured-output schema \
    --max-output-tokens 16384 --call-timeout-secs 300 \
    --max-turns 50 --max-executions 50 --deadline-secs 1200 \
    --state-db "$RUN/data/state.feltdb" --task-id "$RUN_ID" --lease-secs 900 \
    --json \
    > "$RUN/report.json" 2> "$RUN/stderr.log"
echo $? > "$RUN/exit_code"
```

Run it with `setsid` (in its own process group) so that a kill reaches every child process (PAX, cargo, the tests).
See section 8.

### 2.1 Objective

* There is **one positional argument**: the goal text. There is no goal-file flag; pass `"$(cat goal.txt)"`.
* The goal must be non-empty, **at most 2,000 bytes**, and contain no control characters except `\n`
  (`MAX_GOAL_BYTES`, `goal_is_acceptable`, `crates/stack-agent/src/software_work.rs`). A goal that breaks this exits
  2. T4's `tasks/T4.goal.txt` is 1,830 bytes and fits. The longer `tasks/T4-appport-resolver-versions.md` brief
  (2,613 bytes) does **not**.
* A second positional argument is a usage error (exit 2: "quote the goal as one argument").
* `--kind change|verify|inspect` (default `change`). `change` completes only when `pax.test` passes after the last
  file-changing write. `verify` completes when `pax.test` passes with no file changed. `inspect` is read-only and
  never exits 0 (an answer that is grounded but not verified exits 1).
* What the model actually sees: the goal, followed by Chip's own fixed rules text (`COMMON_RULES` plus the completion
  rule), as the system message. A full turn-1 request is saved in `scratchpad/runs/sample-request.json`. It is about
  5.7 KB, or 1,308 prompt tokens for Qwen2.5.

### 2.2 Environment variables

On each setting, a command-line flag takes precedence over its variable.

| Variable | Meaning |
| --- | --- |
| `CHIP_MODEL` / `--model` | required; never guessed |
| `CHIP_ENDPOINT` / `--endpoint` | required for openai-compatible; a URL ending in `/chat/completions`. Plain `http://` is allowed to loopback; a LAN host needs `CHIP_ALLOW_INSECURE_LAN_HTTP=1` |
| `CHIP_PROVIDER` / `--provider` | `openai-compatible` (default) or `anthropic` |
| `CHIP_API_KEY`, else `OPENAI_API_KEY`, else `ANTHROPIC_API_KEY` | sent as `Authorization: Bearer`. **`OPENAI_API_KEY` is set in this environment**, and `doctor` reported "API key: supplied by OPENAI_API_KEY", so it would be sent to the local server. Unset it and set a placeholder `CHIP_API_KEY` |
| `CHIP_MAX_OUTPUT_TOKENS`, `CHIP_TEMPERATURE`, `CHIP_STRUCTURED_OUTPUT`, `CHIP_PROVIDER_PROFILE`, `CHIP_TOKEN_LIMIT_FIELD`, `CHIP_CALL_TIMEOUT_SECS`, `CHIP_DECISION_PROMPT`, `CHIP_CONTEXT_BUDGET_BYTES`, `CHIP_EXECUTOR` | the same settings as the flags |
| `PAX_BIN` | an explicit PAX executable. Otherwise the **first** `pax` on `PATH` is used, and it must answer `pax --version` with `pax X.Y.Z` (at least 0.3.0) |
| `STACK_AGENT_DATA_DIR` (else `$XDG_DATA_HOME/stack-agent`, else `~/.local/share/stack-agent`) | the runtime data directory: the default FeltDB and runtime learning. Set one per run for isolation |
| `CHIP_PROXY`, `CHIP_NO_PROXY`, `CHIP_PROXY_USERNAME`/`PASSWORD` | an explicit CONNECT proxy. Ambient `HTTPS_PROXY`/`NO_PROXY` are **ignored**, so the session proxy does not get in the way of 127.0.0.1 |
| `OTEL_*`, `STACK_AGENT_OTLP_FILE` | opt-in OTLP/JSON trace export of the finished work (`crates/stack-agent/src/telemetry.rs`). The report's `telemetry` is `{"configured":false}` when off |
| `CHIP_CLI2_SOCKET` | opt-in cli2 task capabilities (off) |

The project's own build or test environment (for example `CARGO_TARGET_DIR`) is inherited by PAX and the native tool.

### 2.3 Budgets and limits

| Knob | Flag | Default | Range | Notes |
| --- | --- | --- | --- | --- |
| Model turns | `--max-turns N` | 12 | 1–50 | each model call is one turn, rejected replies included. Ends `limit_reached` |
| Executions (tool calls) | `--max-executions N` | 8 | 1–50 | measured: `--max-executions 1` gave `limit_reached` with reason `"executions limit reached"`, exit 1 |
| Whole-work deadline | `--deadline-secs N` | none | 1–86400 | checked before every model call and every execution. A model call in flight is abandoned; an execution in flight finishes. Measured: `--deadline-secs 20` ended at 20.0 s, `cancelled`, reason `"the whole-work deadline passed; …"`, `delivery:"possibly_sent"`, exit 1 |
| Output tokens per call | `--max-output-tokens N` | 2048 | 1–131072 | sent as `max_tokens` (profile `local`). A reply cut at the cap is a typed failure, never a decision |
| Per-call timeout | `--call-timeout-secs N` | **30** | | **too short for CPU inference.** Measured: the 3B timed out on turn 1 at 30 s, giving exit 4 (`inference failed (timeout)`). Use 300 |
| Context bytes per request | `--context-budget-bytes N` | none | ≥1 | a request over the budget is not sent |
| Temperature | `--temperature T` | 0.0 | 0–2, or `omit` | |
| PAX test timeout | not exposed | 300 s | | fixed in `chip-pax` (`Duration::from_secs(300)`). Enforce a different one with a `PAX_BIN` wrapper |
| Single write | not exposed | 32,768 bytes of `content`; `replace`/`with` edits for larger files | | an oversized write is a terminal invalid decision. This ended both of the Opus T2/T4 runs |
| Reply size | not exposed | one JSON object; `summary`/`reason` at most 1,024 bytes | | |
| Malformed-reply recovery | not exposed | at most 2 rejected replies in a row; the 3rd ends the work | | |
| Stuck guard | not exposed | the same request repeated 3 times in a row with an identical observation ends the work `blocked`, reason starting `stuck: ` | | `docs/product/stuck-guard.md` |

There is **no total token budget** and no cost budget. Only the per-call output cap and the per-request context byte
budget exist. A harness that wants a token budget must enforce it in the model proxy (section 6), for example by
answering HTTP 429 or 400 once spent. That will surface as a model failure, exit 4, or exit 3 on the first call.

### 2.4 Historical T4 configuration (exact)

`docs/product/coding-benchmark-v1/runs/2026-10-22-local-models-68965fb/35b/T4-r1/config.txt`:

```
limits: --max-turns 50 --max-executions 50 --deadline-secs 1200 --call-timeout-secs 300 --max-output-tokens 16384
state: fresh clone/fixture, STACK_AGENT_DATA_DIR=<per-run>/data
model=Qwen3.6-35B-A3B-4bit structured_output=none   (the 4B ran with --structured-output object)
stack_agent=68965fb (sha256 478b4cd3…), pax 0.5.0 + an unpublished Vitest patch (sha256 d16aa4e0…)
```

The Opus runs used the same limits with `--max-output-tokens 32000 --provider anthropic --provider-profile anthropic`
(`runs/2026-10-22-run2-malformed-reply-recovery/run-task.sh`).

## 3. Outputs

### 3.1 stdout

* With `--json`: **exactly one JSON object on one line**, printed at the end. Nothing streams on stdout, and with
  `--json` the progress lines are suppressed too.
* Without `--json`: a human report (`Work blocked.` / `Goal:` / `Executed:` / `Verified: no` / `Tokens: input …` /
  `Next steps:` …). See `scratchpad/runs/r3-schema-3b/report.out`.
* When a terminal `--task-id` is run again, the report says so and nothing runs:
  `{"agent_state":{"recorded":true,"task":{…"status":"cancelled"…}},"command":"work","ran":false}`, exit 1 (measured).

### 3.2 `--json` report schema

The top-level keys, measured:

`agent_state, answer, audit, capability_requests, changed_writes, command, context, delivery, endpoint, episodes,
evidence, executions_by_capability, exit_status, failed_observations, generation, goal, goal_kind, goal_satisfied,
grounded, inspection_coverage, inspection_evidence, invalid_decisions, invalid_inputs, learning, lists,
malformed_replies, measurement, model, model_failures, outcome_reason, paths_written, pax, pax_executions, provider,
reads, receipt, recoveries, searches, telemetry, terminal_state, tests, usage, useful_work_per_execution,
useful_work_per_model_call, useful_writes, verified, workflow, write_conflicts, writes`

These are the fields a harness should key on:

* `terminal_state`: one of `completed`, `escalated`, `blocked`, `limit_reached`, `failed`, `cancelled`.
* `verified`: bool. Only this authorizes exit 0.
* `exit_status`: equal to the process exit code.
* `outcome_reason`: text, or null.
* `pax.last_status`: `passed`, `failed`, `unsupported`, `not_run`, ….
* `pax.last_tests`: test counts.
* `usage.input_tokens` / `usage.output_tokens` / `usage.calls_reported` / `usage.calls_unreported`: **null when the
  server reports no usage**.
* `measurement.model_calls`, `turns`, `executions`, `model_latency_ms`, `compute_latency_ms`, `total_latency_ms`.
* `context.calls[]`: request bytes and reported tokens per call.
* `executions_by_capability`, `paths_written`, `write_conflicts`, `malformed_replies`, `invalid_decisions`,
  `failed_observations`.
* `audit.*`: safety counters (`clean`, `unauthorized_executions`, `false_completions`, `path_escape`, …).
* `model_failures[]`: `{kind, status, delivery}`.
* `agent_state.task_id` / `work_id`.

Real excerpt of a verified run (scripted model, `scratchpad/runs/r12-scripted-verified/report.pretty.json`):

```json
{"command":"work","provider":"openai-compatible","model":"scripted","endpoint":"http://127.0.0.1:8090",
 "goal_kind":"change","terminal_state":"completed","outcome_reason":null,"delivery":null,"model_failures":[],
 "goal_satisfied":true,"verified":true,"grounded":false,
 "executions_by_capability":{"pax.test":1,"project.read":1,"project.write":1},
 "reads":1,"writes":1,"changed_writes":1,"tests":1,"paths_written":["src/lib.rs"],"write_conflicts":[],
 "failed_observations":0,"invalid_decisions":0,"malformed_replies":0,
 "pax":{"last_exit_code":0,"last_reason":"tests-passed","last_status":"passed",
        "last_tests":{"complete":true,"failed":0,"ignored":0,"measured":0,"passed":1},"version":"0.5.0"},
 "evidence":{"invalidated":null,"test_files_replaced":[]},
 "usage":{"input_tokens":300,"output_tokens":30,"calls_reported":3,"calls_unreported":0,"cache_read_tokens":null,
          "cache_write_tokens":null,"reasoning_tokens":null,"costs":[],"models_reported":["scripted"]},
 "exit_status":0,
 "measurement":{"model_calls":3,"turns":4,"executions":3,"local_decisions":1,"model_latency_ms":6.451,
                "compute_latency_ms":676.331,"total_latency_ms":722.47,"model_tokens":330,"outcome":"completed"},
 "agent_state":{"recorded":true,"work_id":"work_0e40eb0cb642ae6d","task_id":"work_0e40eb0cb642ae6d",
                "attempt":2,"resumed_from":"ready","database":"default"}}
```

Here the runtime completed the work itself, as a local decision, right after `pax.test` passed. The model's
`complete` was never needed (`turns` 4, `model_calls` 3).

### 3.3 stderr

* Progress lines are printed only **without** `--json`, one per model turn and per operation:
  `turn N: asking the model`, `  ok      project.read src/lib.rs`,
  `  failed  pax.test (tests failed: 0 passed, 1 failed)`,
  `  failed  project.write src/lib.rs (stale_base: different_content)`,
  `  rejected  decision (1 in a row, limit 2): nothing done; asking again`.
* `--print-reply` prints each model reply (`Model reply:\n<text>`) at the end, in both modes.
* Also on stderr: notes (`note: this work is not persisted…`, `note: removed N temporary file(s)…`), errors, signal
  messages, and the model-unavailable hint.

### 3.4 Files written

* **Inside the project** (unconditionally; there is no opt-out): `.stack-agent/project.json`, plus
  `.stack-agent/learning/runs/<sha>.json` and `.stack-agent/learning/behaviors/<sha>.json`. These show as
  `?? .stack-agent/` in `git status`. **The harness must exclude `.stack-agent/`** from diffs and scoring, or add it
  to `.git/info/exclude` before the run. `run-acceptance.sh` does not exclude it, so it appears in `status.txt` and
  `agent.diff`; the historical runs filtered it by hand.
* The project's own files, through `project.write`: a temp file plus rename. A crash can leave `.chip-write-*.tmp`,
  which the next run removes.
* Build output from the tests that PAX runs, e.g. `target/` unless `CARGO_TARGET_DIR` is set.
* Under `STACK_AGENT_DATA_DIR`:
  * `agent-state/<16 hex of sha256(project path)>.feltdb` (+ `.lock`), the default FeltDB, unless `--state-db FILE`
    or `--no-state`;
  * `runtimes/<id>/installation.json`;
  * `runtimes/<id>/learning/{runs,behaviors}/`.
* Nothing is committed. Stack-Agent never runs a mutating git command.

### 3.5 Durable record (FeltDB) and how to read it

```
stack-agent agent-state list  [--state-db FILE] --json   -> {"tasks":[{"task_id","status","fence","unresolved_intents","updated_at_ms"}]}
stack-agent agent-state show  [--state-db FILE] --task-id ID --json
```

`show` returns these keys: `task`, `events[]`, `intents[]`, `model_responses[]` (per call: `usage.prompt_tokens`,
`usage.completion_tokens`, `output_bytes`, `output_sha256`, `turn`), `model_calls_in_flight[]`, `results[]` (with
`verification.{verified,goal_satisfied,exit_status}`), `last_checkpoint`, `lease_expires_at_ms`, `settlements`,
`reconciliations`, `unresolved`. Example: `scratchpad/runs/r3-schema-3b/agent-state-show.json`.

Each event is
`{"attempt","index","provenance":"runtime_decided|host_observed|model_inferred","recorded_at_ms","event":{"kind",…}}`.
These kinds were seen: `WorkStarted` (goal sha256 and bytes, limits), `CapabilitiesRequested`, `CapabilitiesAvailable`,
`DecisionStarted`, `ModelEscalation` (context bytes and policy), `ModelCalled` (prompt and completion tokens,
`succeeded`, `usage_reported`), `DecisionMade` (e.g. `"request project.git.status"`), `CapabilityRequested`,
`ExecutionRequested`, `ExecutionStarted`, `ExecutionCompleted` / `ExecutionFailed` (output sha256; a PAX failure
embeds the `pax.execution-result.v1`), `ObservationRecorded`, `EvidenceRecorded`, `GoalEvaluated`, and the terminals
`WorkBlocked`, `WorkEscalated`, `WorkFailed`, `WorkCancelled`, …. The record holds no prompts, replies or file
contents, only digests.

**You cannot read it while the work runs.** Measured: `agent-state show` during a run gives
`FeltDB database … is already owned by another process` (exit nonzero). For live observation, use the model proxy log
(section 6), or run without `--json` and tail the stderr progress lines, or use `serve` (section 9).

`stack-agent agent-state export --task-id ID` prints the record as an OTLP/JSON trace.

## 4. Exit codes

The mapping is `crates/stack-agent/src/verify.rs::exit_code` (and docs/known-issues.md §A).

| Code | Meaning | Seen in these runs |
| --- | --- | --- |
| 0 | completed **and** verified (`pax.test` passed after the last change, and the tree is unchanged since that run) | r12 scripted |
| 1 | the runtime worked but nothing was verified: `blocked` (including `stuck:` and three rejected replies in a row), `escalated`, `limit_reached`, `cancelled` (signal or deadline), a grounded inspect, verified evidence later invalidated (tests replaced, or the tree changed after the pass), or a re-run of a finished `--task-id` | r1, r2, r3, r6, r8, r10, r11, the SIGTERM run, the post-kill resume |
| 2 | usage error (bad flag, missing or oversized goal) | |
| 3 | unavailable, nothing ran: no model selected, no PAX (for change/verify), the project is locked by another stack-agent (`another stack-agent work is running in this project directory`), a FeltDB task held under an unexpired lease, a state DB that cannot be opened (explicit `--state-db`/`--task-id`), or a first model call failing as unavailable (connection refused, 401/403/429, model unavailable) | immediate resume after SIGKILL; orphan lock |
| 4 | runtime failure: a model failure after work began, a timeout (including on the first call), a protocol violation (e.g. a non-streaming 2xx), a request for an undeclared capability, a safety-invariant violation, an explicitly requested FeltDB that failed to record a verified result | r9 (30 s timeout), lease-too-short run |
| 130 | a second SIGINT/SIGTERM: immediate exit, outcome not reported | |
| 137 | SIGKILL (from the OS) | |

The process exit code always equals the report's `exit_status`. The exception is the exit-3 refusals that happen
before a run, which print no report or only an `ran:false` stub.

## 5. Capabilities (how Chip discovers what it may do)

* `work` uses a **fixed, compiled-in capability set** for the local project directory
  (`chip_remote_env::project_capability_set`). Measured `CapabilitiesAvailable count=10`:
  * `project.list` (`path`)
  * `project.search` (`query`, `path`)
  * `project.read` (`path`, `offset`, `length`; 32 KiB ranges, returns a sha256)
  * `project.write` (`path`, `content` | `replace`+`with`, `expected_sha256` | `expect_absent`). An edit must carry
    `expected_sha256`.
  * `project.git.status`, `project.git.diff`, `project.git.diff_stat`, `project.git.log` (`count`). These are
    read-only.
  * `project.observe` (`scope`): PAX structural observation.
  * `pax.test`: no inputs.

  `--kind inspect` narrows the set to the read-only eight. `--cli2-socket` adds `cli2.tasks`/`cli2.run`. `--auto` can
  only **narrow** the set.
* The model is told the list and each one's exact request shape inside the system prompt (see
  `sample-request.json`). It is **not** offered as OpenAI `tools`. FX refuses tool definitions, and a streamed
  `tool_calls` delta is a protocol error.
* **AppPort**: `crates/chip-appport-source` is **experiment-only** (`docs/product/capability-sources.md`). It reads
  what an AppPort host served (discovery, capability routes) in replay, inside `chip-experiments`. Production `work`
  cannot select a source-bearing configuration, nothing in `work` reads an AppPort manifest, and there is no flag or
  environment variable to give it a capability set. **A harness cannot inject capabilities into `work`**; it can only
  narrow them (`--kind inspect`, `--auto`) or use the opt-in cli2 bridge.

## 6. Model protocol and the local model server

### 6.1 What stack-agent sends and needs

* One `POST <endpoint>` per turn, OpenAI chat-completions, with `"stream": true` and
  `"stream_options":{"include_usage":true}`. Consecutive system messages are merged. Text only, no tools.
* The reply is **its own JSON protocol** (`chip.work-decision.v1`), not tool calls. It must be exactly one object:
  * `{"decision":"request_capability","capability":"…","inputs":{…}}`
  * `{"decision":"complete","summary":"…"}`
  * `{"decision":"escalate","reason":"…"}`
  * `{"decision":"block","reason":"…"}`

  One surrounding ```` ```json ```` fence is tolerated (measured with the 1.5B under `none`).
* The SSE stream must contain a `finish_reason` before `[DONE]`. A 2xx that is not an event stream gives exit 4.
* `--structured-output` (profile `local` defaults to `schema`):
  * `schema` sends `response_format:{"type":"json_schema","json_schema":{"name","schema":<anyOf of the 4 decisions>,"strict":false}}`;
  * `object` sends the same wrapper with schema `{"type":"object"}`;
  * `none` sends nothing.

### 6.2 llama-cpp-python 0.3.16 incompatibilities (measured)

1. It **rejects `response_format.type = "json_schema"`** with HTTP 500 ("Input should be 'text' or 'json_object'").
   Both `schema` and `object` modes therefore fail against it directly. Only `--structured-output none` works direct.
2. Its streaming response **sends no usage chunk**, so every token field in the report is `null` (`calls_unreported`).

**Fix used here, recommended for the harness:** a small proxy, `scratchpad/shim/llm_shim.py`. It:

* rewrites `json_schema` to llama-cpp-python's `{"type":"json_object","schema":S}`, so decoding is
  grammar-constrained by Chip's real decision schema;
* calls upstream **non-streaming** and re-emits the reply as SSE with `finish_reason`, a `usage` chunk and `[DONE]`;
* logs per call: wall seconds, prompt and completion tokens, finish reason, sizes and optionally the bodies.

With it, stack-agent reported real tokens (r3: `Tokens: input 24920, output 641`), and the proxy log is the harness's
own live, per-call ground truth for model activity. The bakeoff harness (`bench/bakeoff/bakeoff/proxy.py`) uses the
same pattern: a loopback proxy that holds the real key and records calls. The alternative is llama.cpp's own
`llama-server`, which supports `json_schema` and streamed usage, but it would have to be built from source because
GitHub release downloads are blocked.

### 6.3 Setup (exact)

```bash
python3 -m venv /opt/llm/venv
/opt/llm/venv/bin/pip install 'llama-cpp-python[server]==0.3.16' huggingface_hub   # compiles llama.cpp for CPU (~10 min)
mkdir -p /opt/llm/models && cd /opt/llm/models
curl -sSfLO https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
curl -sSfLO https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf
```

| Model file | Size | sha256 |
| --- | --- | --- |
| `/opt/llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` | 1,117,320,768 B | `cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046` |
| `/opt/llm/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf` | 2,104,932,800 B | `724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7` |

Start (one model at a time; the port is 8080):

```bash
cd /opt/llm && nohup /opt/llm/venv/bin/python -m llama_cpp.server \
  --model /opt/llm/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf --model_alias qwen2.5-coder-3b \
  --host 127.0.0.1 --port 8080 --n_ctx 16384 --n_threads 4 --chat_format chatml > llm.log 2>&1 &
echo $! > llm.pid                                   # $! of a plain `nohup …&` is the server itself
until curl -sf http://127.0.0.1:8080/v1/models >/dev/null; do sleep 1; done
# shim (translates json_schema, restores usage, logs calls):
SHIM_LOG=$RUN/model-calls.jsonl python3 -I docs/integration/reference/shim/llm_shim.py 8081 http://127.0.0.1:8080 &
echo $! > shim.pid
```

Stop: `kill $(cat shim.pid) $(cat llm.pid)`. Do not use `pkill -f llm_shim`: it matches the invoking shell's own
command line. Both are stopped now.

Resident memory at `n_ctx 16384` is about 4.4 GB for the 3B. Both models fit in 15 GB.

### 6.4 Measured speed (4 threads, q4_k_m)

| Model | Prompt processing | Generation | Typical stack-agent turn |
| --- | --- | --- | --- |
| 1.5B | 111 tok/s (2,172-token prompt) | 7.9–8.9 tok/s | 6–17 s |
| 3B | 60 tok/s (2,172-token prompt); 43 tok/s on short prompts | 5.1–5.5 tok/s | 6–57 s: 24 s cold first call, ~6 s with prefix reuse, ~55 s for a 172-token whole-file write |

The prompt grows by about 100–300 tokens a turn (r3: 1,308 to 4,030 prompt tokens over 10 turns). llama-cpp-python
reuses the KV prefix of the previous request, which keeps later turns cheap until a large observation arrives. A
50-turn T4-scale run would likely hit `n_ctx 16384` and the 1200 s deadline long before it hit the turn limit.

## 7. PAX usage

* The arguments are fixed: `pax --dir <project root> --json test`. Chip also runs `pax --version` once (5 s probe) and,
  for `project.observe`, `pax --dir … --json observe …`.
* Only stdout is parsed, strictly, as one `pax.execution-result.v1`:
  `{"schema","operation":"test","status","reason","tool","exit_code","tests":{passed,failed,ignored,measured}?}`.
  stderr (the native tool output) is diagnostics only.
* Passing evidence requires `status=="passed"` and, if counts are present, `failed==0 && passed>0`.
* Verification is then re-checked against a project fingerprint, and replaced pre-existing test files invalidate it.
* Ecosystems, measured on PAX 0.5.0:
  * **Cargo is supported**: `failed`/`tests-failed`/101 with counts, then `passed`/`tests-passed`/0.
  * A **Node project (`npm test` / `node --test`) returns `status:"unsupported"`, `reason:"operation-unsupported"`,
    `tool:null`** (`/home/user/pax/docs/PAX_CAPABILITIES.md`: "other ecosystems report `unsupported`").
  * pnpm/vitest (AppPort, i.e. **T4**) is reported `unsupported` by published PAX. A `change` work on T4 therefore
    **cannot reach `verified`/exit 0** with this PAX; at best it ends `escalated`/`blocked` (exit 1) or `failed`. The
    historical local-model runs used an unpublished patched PAX that interprets Vitest JSON. The Opus run with stock
    PAX solved T4 by the evaluator but reported `Last test result: unsupported`, `Verified: no`, exit 4.
* A harness can observe or shim every PAX call through `PAX_BIN` (precedent: `bench/bakeoff/bakeoff/paxwrap.py`). That
  wrapper logs each invocation, can inject faults, and is the only place to change the 300 s test timeout.

## 8. Interruption, cancellation, resume (all measured)

| Event | Behaviour |
| --- | --- |
| SIGINT/SIGTERM (first) | stderr: `stack-agent: terminate received; cancellation requested. No further model call or execution will start; a model call in flight is abandoned (its remote stop is not confirmed); an execution in flight finishes and is not undone…`. The report is still printed: `terminal_state:"cancelled"`, `outcome_reason:"cancellation was requested; …"`, `delivery:"possibly_sent"`, exit 1, FeltDB task status `cancelled`. It stopped promptly. |
| Second SIGINT/SIGTERM | immediate exit 130, no report |
| Deadline | same as cancel, with the deadline reason |
| SIGKILL | exit 137 and no report. The task stays `running` in FeltDB, with `model_calls_in_flight:[{turn:4,outcome:"unknown: …"}]` |
| Restart with the same `--task-id` before the lease expires | exit 3: `task smoke-kill-1 is held by stack-agent under an unexpired lease; it can be resumed once that lease expires; nothing was run` |
| Restart after the lease expires (`--lease-secs 90`, waited 92 s) | resumed: `agent_state.attempt:3`, `resumed_from:"running"`, `restored:{"observations":3}`, `model_call_in_flight:{attempt:2,turn:4,outcome:"unknown"}`, `model_response:{offered:false,reason:"the attempt recorded ExecutionRequested after it"}`. It continued from the restored observations and ended `escalated` (exit 1) in 51 s |
| Restart of a task that already ended (completed, cancelled, blocked, …) | not re-run; `{"ran":false,…}`, exit 1 |
| No `--task-id` | every run is a new task (`work_<16hex>`). Earlier interrupted works are only *reported* (`agent_state.interrupted`, `note: work … was interrupted`) |
| Killing only a wrapper shell | **stack-agent keeps running, orphaned**, and holds the project lock. The next run exits 3 (`another stack-agent work is running in this project directory`). Always signal the process group (`setsid` + `kill -- -PGID`), as the bakeoff runner does with `start_new_session=True` and `os.killpg` |
| `--lease-secs` shorter than one model call (5 s measured) | the work **fails**, exit 4: `durable agent state did not record the intent, so nothing was executed: FeltDB refused renew: LEASE_EXPIRED`. Keep the lease well above `--call-timeout-secs` (the default is 900) |

Executions are never interrupted. An in-flight `pax.test` can outlive the deadline by up to PAX's own 300 s. Effects
that already happened stay done; nothing is rolled back. Resume can repeat effects
("RETRYING A TURN MAY REPEAT EXTERNAL EFFECTS"). An action whose outcome is unknown blocks resume (exit 3) until it is
settled with `agent-state settle|reconcile` (see `bench/bakeoff/bakeoff/runner.py`, `settle_uncertain`).

## 9. Alternative surface: `stack-agent serve`

`serve [--host 127.0.0.1] [--port 8765] [--work-deadline-secs N] [--state-db FILE|--no-state] …` exposes these routes:

* `POST /v1/work {"goal","kind"}`, which returns 202 `{work_id,status,durable}`;
* `GET /v1/work/{id}`;
* `GET /v1/work/{id}/events?after=N` (polling, with `next` and `complete`);
* `POST /v1/work/{id}/cancel`;
* `GET /v1/metrics`.

It gives live events, but **turn and execution limits are fixed at the defaults (12/8)**, with no per-request
budgets or model flags (the model comes from env), and it works on the server's current directory. For an obstacle
course that needs 50/50 budgets, use the `work` CLI.

## 10. Smoke test results (this machine)

Project: `scratchpad/sa-smoke/rust-proj`, a Cargo crate whose `add` returns `a - b`, with one failing test
(git-initialised, `.gitignore` = `/target`). PAX before the run: `failed`/`tests-failed`, 0 passed and 1 failed.
Goal: "Fix the failing test in src/lib.rs so that cargo test passes." Each run used a fresh copy of the project.

| Run | Model / mode | Limits | Result | Wall | Notes |
| --- | --- | --- | --- | --- | --- |
| r1 | 1.5B, direct, `none` | 10/10, 900 s, 512 tok | `escalated`, exit 1 | 17.4 s | 1 call; the reply was fenced JSON (accepted); tokens null (no usage in stream) |
| r2 | 1.5B, shim, `schema` (grammar) | same | `blocked`, exit 1 | 6.2 s | 1 call, 1,308 prompt and 41 completion tokens; the model chose `block` |
| r3 | 3B, shim, `schema` | 12/10, 1200 s, 1024 tok | `blocked`, exit 1 | 278.7 s | 10 calls, 9 executions: git.status, diff, diff_stat, list, pax.test (failed), read, write (**correct fix `a - b` → `a + b`**), then 2 stale `expected_sha256` writes, then block. It never re-ran pax.test, so the result is not verified although the tree is fixed. Tokens: 24,920 in and 641 out |
| r6 | 3B, shim | `--deadline-secs 20` | `cancelled`, exit 1 | 20.0 s | deadline |
| r7 | 3B, shim | `--max-turns 2` | `escalated`, exit 1 | 19.7 s | the model gave up before the limit |
| r8 | 3B, shim | `--max-executions 1` | `limit_reached`, exit 1 | 9.9 s | `executions limit reached` |
| r9 | 3B, shim, explicit goal | default 30 s call timeout | `failed`, exit 4 | 30.1 s | `inference failed (timeout): delivery possibly_sent` |
| r10, r11 | 3B, shim, explicit "use replace/with" / "whole file" goals | 300 s timeout | `blocked`, exit 1 | 32 s / 67 s | the grammar lets it fill every optional input; `expect_absent:false` was rejected as invalid input, then it blocked |
| r12 | scripted stub (`scratchpad/shim/scripted_model.py`) | 8/8 | **`completed`, verified, exit 0** | 0.8 s | read, then a write with `replace`/`with`/`expected_sha256`, then pax.test passed; the runtime completed itself |
| SIGTERM | 3B, durable, task `smoke-term-1` | | `cancelled`, exit 1 | ~12 s | see section 8 |
| SIGKILL+resume | 3B, durable, task `smoke-kill-1`, lease 90 s | | 137, then 3, then resumed to `escalated` (1) | | see section 8 |

In every run the audit was clean: 0 unauthorized executions, 0 false completions, 0 path escapes.

## 11. T4 and the evaluator

* **The brief** is `docs/product/coding-benchmark-v1/tasks/T4.goal.txt` (passed as the goal). The repository is
  appport @ `268c9b46a71a5f2b4aea86d6c73a4a4371958f1f` (TypeScript, pnpm, vitest). The defect is that
  `packages/core/src/resolver.ts` uses `provides.find(name)`, which always picks the lowest version.
* **`evaluator/prepare-checkout.sh TASK DIR`** does the following:
  1. `git clone --no-tags https://github.com/rkendel1/appport.git DIR`, then a detached checkout of the base;
  2. deletes every branch and remote ref, removes `origin`, expires the reflog and runs `gc --prune=now`, so no newer
     history can be read;
  3. prints HEAD;
  4. for T2/T4, runs `pnpm install --frozen-lockfile`.

  It needs git with GitHub access (verified: `git ls-remote` of appport works through the session proxy), plus
  pnpm 10 and Node 22 (present: `/opt/node22/bin/pnpm` 10.28.0, node v22.22.0). DIR must not exist.
* **`evaluator/run-acceptance.sh TASK CHECKOUT OUT_DIR`** does the following:
  1. requires HEAD == base (exit 2 if the agent committed) and that the acceptance file is not already present;
  2. saves `status.txt` and `agent.diff` (tracked diff plus untracked files; **`.stack-agent/` is included**);
  3. for T2/T4, runs `pnpm install --frozen-lockfile --prefer-offline` and records the audit-snapshot test (not
     scored);
  4. runs the regression suite `npx vitest run --exclude spec/test/audit.test.ts --exclude '**/node_modules/**'`, and
     re-runs it once if only the known-flaky tests failed;
  5. copies the hidden test `evaluator/acceptance/resolver-multi-version-acceptance.test.ts` to `spec/test/`, runs
     `npx vitest run spec/test/<file>`, then removes it;
  6. writes `verdict.txt` (`regression: pass|FAIL`, `acceptance: pass|FAIL`, changed files).

  It exits 0 only if both pass.

  The agent must not be able to read `docs/product/coding-benchmark-v1/` (the hidden tests and reference diffs live
  in the stack-agent checkout). So run it with a filesystem view that contains only the prepared checkout, and keep
  the stack-agent source tree out of reach.
* **Was T4 run against stack-agent?** Yes, despite the README's "Not yet run" status line:

  | Run | Model and PAX | Outcome | Evaluator |
  | --- | --- | --- | --- |
  | `runs/2026-10-22-claude-opus-5-5/` (run 1) | `claude-opus-5-5` | 0/4 solved overall | |
  | `runs/2026-10-22-run2-malformed-reply-recovery/T4` | `claude-opus-5-5`, stack-agent `65815ec`, stock PAX 0.5.0 | `failed`, exit 4 after 448 s and 19 calls; 908,598 input and 46,424 output tokens; pax.test `unsupported` | **solved** (regression pass, acceptance pass). The failure was an oversized whole-file write to `docs/audit.json` |
  | `runs/2026-10-22-local-models-68965fb/{35b,4b}/T4-r{1,2,3}` | Qwen3.6-35B-A3B (`none`) and Qwen3.5-4B (`object`), patched PAX | 35B: 3× `blocked` (stuck guard while orienting; 13–20 reads, no write, up to 639 s); 4B: 3× `escalated` | all 6 failed acceptance |

  Registry entries: `bench/registry/experiments/coding-benchmark-v1-local-models.json` and
  `coding-benchmark-v1-run2-malformed-recovery.json`.
* **The bake-off harness** (`bench/bakeoff`) is the in-repo precedent for an orchestrator:
  * a loopback model proxy that holds the key and counts calls;
  * a `PAX_BIN` wrapper;
  * `STACK_AGENT_DATA_DIR`/`CARGO_TARGET_DIR` per run;
  * `--json`;
  * `--state-db`/`--task-id`/`--lease-secs`, or `--no-state`;
  * a process group killed with SIGTERM and then SIGKILL at the deadline + 120 s;
  * resume after lease expiry, and settlement of uncertain intents.

  Its plans use their own per-task budgets (`task["budgets"]`), not 50/50/1200.

## 12. What the harness cannot control or observe

1. **Capabilities.** The set is fixed and compiled in. There is no way to add AppPort or other tools, or to supply a
   manifest; you can only narrow it (`--kind inspect`, `--auto`). The capability text the model sees is fixed.
2. **The prompt.** System and rule text are Chip-owned. The only lever is `--decision-prompt full|compact`
   (experimental). The goal is limited to 2,000 bytes.
3. **Token and cost budgets.** There is no total-token budget. Usage depends on the server reporting it; with stock
   llama-cpp-python it is null. Cost is never computed.
4. **PAX.** The test command is fixed (`pax --dir . --json test`), there is no test filter, the timeout is 300 s, and
   it runs the **whole** suite. For Node/pnpm/vitest it returns `unsupported`, so T2/T4-style tasks can never be
   verified (exit 0) with published PAX 0.5.0. On a repository whose base suite already fails, it stays red. Only a
   `PAX_BIN` wrapper can change this.
5. **Live progress with `--json`.** stdout is a single final report and progress lines are suppressed; FeltDB is
   locked during the run, so `agent-state show` fails. Live observation needs the model proxy log, non-`--json`
   stderr parsing, or `serve`, which has fixed 12/8 limits.
6. **Reasoning content.** Model replies are not kept in the report. Use `--print-reply` (stderr, at the end) or the
   proxy log. FeltDB stores only digests.
7. **Interruption semantics.**
   * An in-flight execution is not interrupted, and a model call is abandoned with remote stop "unconfirmed". With
     llama-cpp-python the server keeps generating the abandoned request and delays the next one.
   * Resume waits for the lease (no forced takeover), and effects may repeat.
   * An action with an unknown outcome needs operator settlement.
8. **Files in the project.** `.stack-agent/` learning files are always written into the checkout. There is no
   opt-out; exclude them.
9. **Concurrency.** One work per project directory (OS lock). Parallel runs need separate checkouts and separate
   `STACK_AGENT_DATA_DIR`s.
10. **Determinism.** Even at temperature 0, identical smoke runs with the 3B diverged (r3 got as far as writing; the
    SIGTERM-test pre-run escalated at turn 4), probably because goals and work ids differ in the context. Budget for
    repeats.
11. **Structured output against llama-cpp-python.** Grammar enforcement needs the shim; with it, schema-valid replies
    can still carry semantically invalid inputs (e.g. `expect_absent:false`), which Chip rejects.
12. **Internal limits**, none configurable: the 32 KiB write cap, 2 rejected replies in a row, the 3× stuck guard,
    the 4,096-byte reply cap and the 1,024-byte reason/summary.

## 13. Blockers and recommendations

* **T4 with a 1.5B/3B CPU model is not realistic.** The small models already fail a one-line Rust fix. T4 needs
  reading 13–20 files, and generation runs at 5–9 tok/s. Even the 35B local model failed T4 historically.
* T4 cannot be verified by stack-agent itself without a Vitest-capable PAX, so score it only with
  `run-acceptance.sh`.
* Use the shim (or an equivalent harness proxy) in front of llama-cpp-python. It is required for grammar-constrained
  replies and for token counts.
* Always set `--call-timeout-secs 300` (or more), a lease above it, `setsid` plus process-group kill, unset
  `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, a per-run `STACK_AGENT_DATA_DIR`, and exclude `.stack-agent/`.
