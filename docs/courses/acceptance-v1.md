# Course acceptance: evaluator resolution, `acceptance.v1`, and the preflight gate

A course version says **how** a run is accepted, explicitly, and cannot be published until a preflight
has shown that its acceptance can tell a broken fixture from a fixed one. This page is the reference for
course authors and for whoever reviews a course change.

- Schema and validator (shared by the app and the harness): `feltkit/lib/acceptance-v1.js`
- Interpreter: `harness/evaluator/declarative.mjs` (called from `harness/evaluator/index.mjs`)
- Preflight: `harness/preflight/index.mjs`, `npm run courses:preflight -- <course>/<version>`
- App side: `courses.publish@1`, `courses.preflight.record@1` (`feltkit/courses.ts`), contract in
  [docs/contracts/harness-app.md](../contracts/harness-app.md)

## 1. Evaluator resolution (`course.evaluator`, required)

Every course document has a top-level `evaluator` section. There is no implicit evaluator and nothing is
ever skipped silently.

| `evaluator` | Acceptance comes from | At run time |
| --- | --- | --- |
| `{ "kind": "declarative", "reference"?: { "file", "digest" } }` | the `acceptance` section, an **acceptance.v1** spec, interpreted by the harness | runs with **no `evaluator/` directory** (a declarative course must not have one) |
| `{ "kind": "private", "dir": "evaluator", "version", "digest", "reference"?: { "file" }, "provenance"? }` | a trusted private evaluator directory next to `course.json` (hidden tests, reference fix); `acceptance` is its configuration (`aoc.private-acceptance.v1`) | the directory's digest is **re-computed at evaluation** and must equal `digest` |
| `{ "kind": "none", "reason"? }` | nothing | the run ends **ERROR** (`failureClass: "evaluator"`, reason `evaluator-missing`) before the agent starts |

A missing or invalid declaration, an invalid acceptance, a private directory that is missing or whose digest
differs (`evaluator-digest-mismatch`), or a course document whose digest differs from the run's
(`course-digest-mismatch`) all end the run **ERROR** with `failureClass: "evaluator"` — never PASS, never FAIL.

`reference.file` is the reference fix used by `reference-control` and preflight. It is private: never
published, never in a workspace. A declarative course keeps it outside `evaluator/` and `fixture/`
(e.g. `reference/fix.diff`) and pins it (`reference.digest`, sha256 of the file); a private course keeps it
under `evaluator/` (covered by `evaluator.digest`). `npm run courses:pin` writes the digests.

## 2. `acceptance.v1` (declarative)

```json
{
  "schema": "acceptance.v1",
  "summary": "…",
  "toolchain": ["cargo"],
  "setup": [{ "id": "install", "argv": ["pnpm", "install", "--frozen-lockfile"], "timeoutSecs": 600 }],
  "require": { "kind": "all", "id": "accept", "of": [ /* checks */ ] },
  "preflight": { "baseline": { "mustFail": ["…"], "mustPass": ["…"], "counts": { "…": { "passed": 1, "failed": 2 } } },
                 "reference": { "counts": { "…": { "passed": 3, "failed": 0 } } } }
}
```

Every field above is the complete set: an unknown field anywhere, or an unknown check kind, is a validation
error — at publish (the app) **and** at run time (the harness re-validates before running anything).

### Check kinds (the finite registry)

Common fields: `id` (lowercase, unique across the spec), `kind`, optional `description`.

| Kind | Fields | Passes when |
| --- | --- | --- |
| `command` | `argv`, `timeoutSecs`, `exit`, `cwd?` | the approved command exits as `exit` says (`{ "equals": n }`, `{ "in": [..] }`, `{ "notEquals": n }`; required) |
| `test` | `argv`, `timeoutSecs`, `exit`, `format` (`cargo`\|`vitest`\|`none`), `counts?`, `cwd?` | exit as declared AND parsed counts within bounds (`{ passed?, failed?, skipped? }`, each `{ equals?, min?, max? }`). Results captured: exit, counts, failing tests, output tail |
| `output` | `of` (an earlier `command`/`test` id), `stream` (`stdout`\|`stderr`\|`both`), `match` | the captured output matches |
| `files-exist` | `paths` | every path exists inside the evaluation tree |
| `file-content` | `path`, `match` | the file (≤ 1 MiB, inside the tree) matches |
| `invariant` | `invariant`: `unchanged` (`paths`), `absent` (`paths`), `no-commits` | the paths are byte-identical to the pristine fixture / do not exist / HEAD and refs are still the base |
| `all`, `any` | `of` (1–32 checks) | all / at least one child passes. The root (`require`) must be one of these: there is no default |

`match` is exactly one of `{ "exact": s }`, `{ "contains": s }`, `{ "regex": r, "flags"?: "imsu" }`,
`{ "jsonPointer": "/a/0/b", "equals": <JSON> }` (RFC 6901; the text must parse as JSON).

### Bounds and safety

- **No shell, no scripting.** `argv` is an array; `argv[0]` is a bare name from the approved programs
  (`cargo`, `node`, `npm`, `npx`, `pnpm`), listed in `toolchain`, and belonging to the fixture's ecosystem
  (`environment.ecosystem`: `rust-*` → cargo; `node-*` → node, npm, npx, pnpm). Sub-commands are allowlisted
  (`cargo test|build|check|run|clippy|fmt|doc|bench|metadata|tree`, `npm test|run|run-script|ci|install|ls`,
  `npx vitest|tsc|jest|mocha`, `pnpm install|test|run|list|ls`) and flags that would run code that is not part of
  the evaluation tree are refused (`node -e/--eval/-p/-r/--require/--import/--loader`, `npx -y/-p/-c`,
  `cargo --config/-Z`, …).
- `timeoutSecs` is required, 1–3600 per command, ≤ 7200 in total; a timed-out command is killed (process
  group) and its check **fails**.
- Paths are relative to the evaluation tree: no absolute paths, no `..`, `.`, empty segments, backslashes or
  `.git`. A symlink that resolves outside the tree is never followed (the check fails).
- Regexes: ≤ 256 bytes, flags `imsu`, no backreferences, no lookaround, no nested quantifiers.
- ≤ 64 checks, ≤ 16 commands, ≤ 4 setup commands, nesting depth ≤ 4.
- Setup commands run first; a failing setup is an environment fault (ERROR), not the agent's.

### Results: nothing passes without having run

Every check record has `executed`. A check that could not run (missing referenced output, a command that
could not start, counts the harness could not parse) is `not-run` or `error` — never `pass`. Composition does
not short-circuit: every check runs and is recorded. `all` = every child pass; else `fail` if a child
failed, else `error`. `any` = some child pass; else `error` if a child errored or did not run, else `fail`.
A root `error` is an evaluator error (outcome ERROR).

The result is its own record (`aoc.acceptance-result.v1`: `eval/acceptance.json`, evidence
`acceptance:result`, `RunResult.evaluation.acceptanceResult`). The outcome is classified from that record and
harness state only; the course's `scoring` section — and any future scorecard — is never an input, so no
score can turn a failed acceptance into a PASS.

### Where it runs

In a fresh evaluation tree: the pristine cached fixture plus the agent's diff (ignored files such as
`node_modules`, `target/`, `.stack-agent/` never reach it), with the evaluator's allowlisted environment.
The agent never sees the evaluation tree.

## 3. Private evaluators

Keep complex logic (hidden test files, multi-step scripts) in a private evaluator. Its configuration in
`acceptance` (`schema: "aoc.private-acceptance.v1"`) is validated just as strictly (known fields only,
approved argv): `toolchain`, `install?`, `recordOnly?[]`, `regression?` (`command`, `knownFlaky?`),
`hidden[]` (`file` under `evaluator/`, `dest`, `command`), `timeoutSecs?`, `preflight`. Hidden files are
copied into the evaluation tree only for their command and removed after; their output (test names,
assertions) stays on the harness host — the app receives exit, counts and the log's digest only.

## 4. Preflight: the release gate

```bash
npm run courses:preflight -- course-000-calibration/v1     # writes courses/course-000-calibration/v1/preflight.json
npm run courses:preflight -- course-001-ddmrv/v1 --out /tmp/t4.json   # or --no-write
```

Preflight runs the real stage pipeline twice (the unchanged fixture with `null-control`, the reference with
`reference-control`) and records named gates:

| Gate | Passes when |
| --- | --- |
| `evaluator-resolved` | the evaluator declaration resolves (`none`, missing or invalid fail here and nothing else runs) |
| `course-valid` | structure, pins, approved commands, and no private content in `course.json` |
| `fixture-reproducible` | the fixture prepared twice (cache + an independent copy) has the same digest and base commit, equal to the pin |
| `baseline-fails` | the unchanged fixture's outcome is FAIL with acceptance `fail`; every `preflight.baseline.mustFail` check failed (and ran), every `mustPass` passed, declared `counts` match exactly |
| `reference-passes` | the reference's outcome is PASS; every acceptance check passed; declared `reference.counts` match |
| `checks-executed` | every acceptance check of both runs has a record and executed; none reports pass without having run |
| `evidence-captured` | the harness's own evidence and the course's `evidence.required` were captured (agent-only items such as `agent.report` are "not applicable" to a control) |
| `evaluator-isolated` | no private file is inside, or copied into, the fixture cache or a workspace; the agent stage watched the course directory and the evaluator code; the report itself leaks nothing |
| `tamper-detected` | a changed private evaluator (`evaluator-digest-mismatch`) or a changed acceptance (`course-digest-mismatch`) makes evaluation ERROR |
| `cleanup` | evaluation copies deleted, the fixture cache unchanged, preflight scratch removed |

The report (`aoc.preflight.v1`) holds the course id/version/digest, the evaluator kind/version/digest, the
acceptance digest, harness versions, each gate with its result and evidence (ids, results, counts, digests —
never evaluator source, hidden output or the reference fix), and `result` (`pass` only if every gate passed).
It is stored next to `course.json` as `preflight.json` and sent with the document by `npm run seed:courses`.

**The app refuses to publish** a new course version unless a passing report is recorded for exactly its digest,
evaluator kind (and, for a private evaluator, its pinned digest) and acceptance digest
(`preflight_required` / `preflight_failed` / `preflight_mismatch`). The report that gated a publish is bound to
the version (`preflightId`, `preflightReportDigest`) and frozen: once a digest is published, no further report
can be recorded for it.

What preflight does **not** prove: it runs controls, not agents; "isolated" is detected, not prevented (the
agent runs as the same OS user; a write to the course directory or the evaluator code is a critical violation
and a changed private evaluator ERRORs at evaluation); `fixture-reproducible` compares source trees (git
fixtures exclude `node_modules` from the digest).

## 5. Immutability and provenance

- A published version's document — including `evaluator` and `acceptance` — never changes; the app stores
  `acceptanceDigest` (sha256 of canonical JSON of `acceptance`) with it. Change acceptance by publishing a new
  version (with its own preflight).
- Each run records `reproducibility.evaluator = { kind, version, digest }` and
  `reproducibility.acceptanceDigest`. The harness re-checks the private evaluator digest and the course digest
  at evaluation; the app refuses a result whose provenance does not match the run's course version
  (`evaluator_mismatch`), and a PASS or FAIL without it.

## Shipped courses

| Course | Evaluator | Preflight (baseline → reference) |
| --- | --- | --- |
| `course-000-calibration/v1` | declarative (no `evaluator/`): `cargo test --lib` (≥ 2 passed, 0 failed), `cargo test --test inclusive_ranges` (exactly 3 passed), invariants on the tests/manifest, documentation and API content checks, an output check | unit tests 1/2 and acceptance tests 1/3 at the base (FAIL); 2/2 and 3/3 with the reference (PASS) |
| `course-001-ddmrv/v1` (T4) | private (`evaluator/`, stack-agent T4 files, `PROVENANCE.json`) | hidden acceptance 2/8, regression 1660 passed at the base (FAIL; one rerun only if just the known-flaky integration-e2e fails); 8/8 and regression pass with the reference (PASS) |

Course-000 became declarative by moving its acceptance tests into the public fixture
(`tests/inclusive_ranges.rs`, required unchanged) instead of a hidden test; its reference fix moved to
`reference/fix.diff`. A test-only private variant of it (`harness/test/fixtures/private-course-000`) keeps the
private-evaluator path covered by fast tests.
