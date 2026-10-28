# Agent Obstacle Course

Evaluate **whole agent systems** — agent runtime + model + tools + controls — on real tasks under controlled
conditions, record what actually happened, and let an **independent evaluator** decide.

The product never reports a pass because the agent says it succeeded. Every run keeps three things apart:

| | Who asserts it | Where you see it |
| --- | --- | --- |
| **Agent claims** | the agent, about itself (untrusted) | Live Run lane, Report "Agent claims" |
| **Runtime observed** | the harness, the runtime, PAX | Live Run lane, Report "Runtime observed" |
| **Evaluator verified** | the evaluator, in a fresh copy of the final workspace | Live Run lane, Report "Evaluator verified" |

A `PASS` is accepted only with an evaluator acceptance pass and no completed critical violation; the app refuses any
other `PASS` even if the harness sends one.

## Quick start

```bash
npm install
npm run dev                 # app on http://localhost:3000, FeltKit Studio linked from the header
npm run seed:courses        # in another terminal: publish courses/*/*/course.json as the dev admin
npm run harness:key -- --out .feltkit/harness.key   # an API key for the harness (role: harness), shown once
```

Sign-in in development is a dev identity picker (top right): **ada** (admin), **grace** (developer), **linus**
(viewer).

Optional: select the environment's model in Studio → Models (or `npx feltkit model set --provider custom --model
<model> --endpoint <url>`), then `npm run model:sync` so the Agent Configuration screen shows it (`seed:courses` also
does this).

### Start the harness

<!-- HARNESS: the harness agent adds its commands here (work authority, model proxy, dispatcher/worker). -->

### Harness

Full guide: [docs/harness/README.md](docs/harness/README.md) (what is enforced vs not, known gaps, recorded runs).

Tools are found through the environment variable, then `PATH`, then the usual install locations
(`~/.cargo/bin`, `~/.local/bin`):

| Tool | Needed for | Install | Override |
| --- | --- | --- | --- |
| `feltdb-server` 0.3.0 | the work authority (every run) | `cargo install feltdb-server --version 0.3.0 --locked` | `FELTDB_SERVER_BIN` |
| `pax` 0.5.0 | evidence (every run) | build PAX and put it on `PATH` | `AOC_PAX_BIN` |
| `stack-agent` | Stack-Agent runs | `cargo build --locked --release --bin stack-agent`, put it on `PATH` | `AOC_STACK_AGENT_BIN` |
| llama-cpp-python + GGUF | local-model runs | `pip install 'llama-cpp-python[server]'` | `AOC_LLM_PYTHON`, `AOC_MODELS_DIR` |

```bash
npm run harness:authority:setup                          # local feltdb-server 0.3.0 work authority (once)
npm run harness:model:start -- --model 3b                # llama-cpp-python + model proxy (only for model-driven agents)
npm run harness:key -- --out .harness/harness-api-key    # with the app running
AOC_APP_URL=http://127.0.0.1:3000 AOC_HARNESS_API_KEY=$(cat .harness/harness-api-key) npm run harness:start
npm run harness:test                                     # harness unit + Durable Work tests
npm run harness:run -- --course course-000-calibration/v1 --adapter reference-control   # one run without the app
```

<!-- /HARNESS -->

## Screens

| Screen | What it does |
| --- | --- |
| **Courses** (Library) | Published course versions: skills, difficulty, environment, compatible configs, runtime and limits, scoring dimensions, deterministic / randomized / adversarial, version + digest, acceptance summary. Launch, inspect the spec, create a variation. |
| **Configure** | A reproducible experiment definition: adapter + version, model provider / model / endpoint / credential reference (the environment's Intelligence selection is shown and can be adopted), inference settings, capability subset, budgets (turns, executions, deadline, per-call timeout, output tokens), recovery, flags. Digest = sha256 of canonical JSON, shown live. Editing creates a new revision. |
| **Runs → Live** | Objective and stage timeline, agent status, model and tool calls, file changes, failures and recovery, tests, budget use, verification status, in three lanes. Updates live while the harness reports. Cancel. |
| **Runs → Report** | Outcome (PASS / FAIL / BLOCKED / ERROR / CANCELLED), acceptance checks, violations (attempted vs completed), trace, recovery history, time and resources, tool use, configuration, evidence, failure classification, reproduction ("configuration reproducible" vs "behaviourally deterministic"). Rerun. |
| **Compare** | One course version only. Verified completion, outcomes, acceptance-check ratio, time (median / p90), every reported metric, recovery, violations, failure categories. Separate dimensions, no single score; anything unreported is "not observed". |
| **Builder** | A structured course.json editor (identity, objective, environment, capabilities, constraints, obstacles, acceptance, scoring, evidence, cleanup, meta). Drafts can be edited; publishing (admin) creates an immutable version. |
| **Runs** (History) | Filter by course version, experiment, agent, model, outcome; one-click rerun (same experiment revision, same course version); select runs to compare. |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the harness contract
[docs/contracts/harness-app.md](docs/contracts/harness-app.md).

- **App** (`feltkit/`, `src/`): FeltKit 0.2.0 on one FeltDB instance. Collections: `courses`, `courseVersions`
  (immutable once published), `experiments` (immutable revisions), `runs` (projection), `runEvents`, `evidence`,
  `modelObservations`. UI: Vite + React with FeltKit live queries.
- **Run lifecycle** is owned by FeltDB Durable Work on `feltdb-server`, driven by the harness. The app's run record
  is a projection: people may only request a run, request a cancel, and rerun; everything else arrives through the
  harness capabilities (`runs.pending`, `runs.cancellations`, `courses.version`, `runs.admitted`, `runs.stage`,
  `runs.events.append`, `runs.evidence.add`, `runs.completed`), authorized for the `harness` role only.
- **Roles**: `admin` (everything, incl. publishing courses, API keys, Intelligence, Configuration), `developer`
  (configure, launch, cancel, rerun, compare, draft courses, Studio agent read), `viewer` (read), `harness` (the
  contract capabilities only; every AppPort Services API key holds exactly this role).

## Commands

| Command | |
| --- | --- |
| `npm run dev` | development server (app, AppPort, MCP, Studio) |
| `npm test` | tests against real, isolated FeltDB instances and real AppPort HTTP (no mocks) |
| `npm run typecheck` / `npm run build` | TypeScript; FeltKit build (backend bundle + frontend) |
| `npm run seed:courses [-- --dir <dir>] [--dry-run]` | publish every `courses/<course>/<version>/course.json` with its `preflight.json` (never reads `evaluator/` or reference fixes) |
| `npm run courses:preflight -- <course>/<version>` | the release gate: baseline must fail, reference must pass, every check executed, evaluator isolated and tamper-evident; writes `preflight.json` ([docs/courses/acceptance-v1.md](docs/courses/acceptance-v1.md)) |
| `npm run harness:key [-- --name <n>] [--out <file>]` | create a harness API key (development) |
| `npm run model:sync` | record the environment's Intelligence selection for the Configure screen |
| `npx feltkit doctor` / `npx feltkit inspect` | health and state |

The seed, key and model scripts use the running dev server when there is one (development sign-in as `ada`, AppPort
`POST /appport`, the AppPort Services console for keys), otherwise they open the development environment directly.

## Status (honest)

- **Works and is tested**: course publishing with canonical-JSON digests and immutability (all change paths refused,
  also after restart), gated by a passing preflight report bound to the exact digest; explicit evaluator resolution
  (declarative `acceptance.v1` or a pinned private evaluator; `none`/missing/invalid/tampered → ERROR); experiment digests and revisions; the full harness contract over AppPort HTTP with a real API
  key (idempotent replays, fencing, cancel before/after admission, inconsistent results refused); comparison per
  course version; rerun; event ordering and bounds; durability across restarts; live change notifications.
- **Depends on the harness**: nothing runs an agent until the harness (`harness/`) is started; launched runs wait in
  `requested`.
- **Known limitations**
  - FeltKit 0.2.0 functions cannot read AppPort Services Intelligence directly, so the environment's model selection
    is a dated observation recorded by an admin (`npm run model:sync`); Intelligence stays authoritative.
  - FeltKit 0.2.0 has no index declarations for application collections; every request-path read is an equality
    filter with an explicit limit (or a bounded page), never an unbounded scan, but FeltDB's embedded runtime
    evaluates them over its in-memory collection cache.
  - The UI was checked by type-checking, the production build, and the dev server serving every module and answering
    every query; it was not exercised in a real browser in this environment (none was available).
  - Development sign-in and the services console are development-only; production needs an `auth.authenticate`
    hook and `FELTKIT_API_KEY_VERIFIER_KEY`.
