# Stack-Agent efficiency experiments: lessons

The canonical record of what the token-economics work, the adaptive-context work and the Agent Obstacle Course
experiments have shown so far. It interprets the original records; it does not replace them. Every number here comes
from a saved artifact listed under [Sources](#sources); nothing was re-run or recomputed from memory.

Labels used throughout:

- **Observed**: read directly from a saved artifact.
- **Interpretation**: an explanation the evidence supports, with the evidence named.
- **Hypothesis**: plausible, not established.
- **Proposed**: an action that has not been implemented or validated.

Recorded 2026-10-29 from agent-obstacle `claude/peaceful-gates-zhpb4h` @ `e2f38d9` and Stack-Agent
`claude/adaptive-context` @ `4a9b05b`. No paid model calls, benchmarks or runtime changes were made to write it.

## A. Executive findings

1. **Observed.** Adaptive context (`auto`) did not reduce input tokens or cost in the only controlled comparison so far
   (`ab-adaptive-context-v1`, Opus 5.5, prompt cache on, build `4a9b05b`).
   - course-000: median total input 12,137 (auto) vs 11,280 (replay) tokens per run.
   - T4: 3,139,869 vs 3,000,775 tokens.
   - Correctness: course-000 5/5 vs 5/5 PASS; T4 2/3 vs 3/3 PASS.
   - Per the pre-registered decision rule, `auto` did not earn promotion; `replay` remains the default.
2. **Observed, root cause confirmed in the traces.** On T4, `auto` switched to the Deep profile in every run, citing
   "conflicting evidence". The cited pair was always the agent's first two `pax test` runs: the course's injected
   transient infrastructure failure, then a real result. Deep was then used for 27–34 of 45–47 calls.
   - **Proposed:** a narrow selector correction (section C).
3. **Observed.** Prompt caching dominates input cost. 93–95% of T4 input tokens were cache reads, and each cached T4
   run cost about $2.00–$2.44.
   - **Interpretation, a projection rather than a controlled comparison:** the earlier uncached Opus T4 run would cost
     about $11.97 at the same prices.
4. **Observed.** Stack-Agent never reported "verified" on T4 in either arm, including the five evaluator PASSes. Every
   T4 run's audit snapshot (`spec/test/audit.test.ts`) failed. The evaluator records that snapshot but does not score
   it.
   - **Interpretation:** the agent-visible test suite and the scored acceptance contract disagree, so the agent's
     internal status cannot match the evaluator's verdict on T4 v2.
5. **Observed.** One `auto` T4 run failed the regression suite (1 test) while passing 8/8 hidden acceptance tests. The
   failure recurred intermittently only with that run's change. Its classification remains **inconclusive**.
6. **Observed in code and tests.** Validation found and fixed a durable-state defect in which a resumed task could
   continue with only part of its goal. A continuation must now give the admitted goal byte for byte.
7. **Observed in a probe and in code.** Stack-Agent renews its lease only before tool executions, never during model
   calls. A run of slow calls can lose the lease, and that limit is why interrupted runs wait about 6 minutes before
   they can be taken over.

## B. Adaptive-context A/B results

**Experiment:** `ab-adaptive-context-v1`.
- **Plan:** [`ab-adaptive-context-v1.json`](ab-adaptive-context-v1.json), amended twice (see its `amendments` field).
- **Build:** `adaptive-4a9b05b` (Stack-Agent `4a9b05b`, sha256
  `08f6431deec7f5e2021019e7707e07c266544d8c1d7ea84b4aac955acae6548a`).
- **Model and settings:** Anthropic `claude-opus-5-5`, `--prompt-cache on`, durable state on, budgets
  50/50/1200 s/300 s/16,384.
- **Evaluator:** `@aoc/evaluator@1.1.0+dcdbd8767c7d`.
- **Arms:** `--context-profile replay` vs `--context-profile auto`, launched in ABBA order.

Every run's record carries the binary commit, the effective profile and cache setting (read from the agent's own
report) and the run labels.

**Cost** is computed from provider-reported token counts at the plan's listed prices: input $4, cache read $0.20,
cache write $5 and output $20 per million tokens. Anthropic does not report a dollar amount, so no
"provider-reported cost" exists. Token counts are provider-reported. Total input = uncached input + cache read +
cache write.

### course-000 (course-000-calibration@v2, obstacle transient-test-failure)

Source: [`ab-adaptive-context-v1.course-000.results.json`](ab-adaptive-context-v1.course-000.results.json), 10 runs,
commit `d67904b`.

| Per run | replay (n=5) | auto (n=5) |
| --- | --- | --- |
| Evaluator outcome | 5 PASS | 5 PASS |
| Obstacle injected / recognized / recovered | 5/5/5 | 5/5/5 |
| Agent status (`completion`) | completed, verified by runtime: 5/5 | completed, verified by runtime: 5/5 |
| Profiles used | replay (recorded as `none`) on every call | Standard on every call (4 per run) |
| Model calls | 4, 4, 5, 4, 4 | 4 in all |
| Tool executions | 4, 4, 5, 4, 4 | 4 in all |
| Total input tokens: median (range) | 11,280 (11,273–15,713) | 12,137 (12,121–12,167) |
| Uncached input: median | 676 | 1,542 |
| Cache read: median | 9,460 | 9,458 |
| Cache write: median | 1,160 (run 1: 3,160) | 1,146 |
| Output tokens: median (range) | 825 (736–1,200) | 440 (413–604) |
| Cost per run: median (sum) | $0.0283 ($0.1553) | $0.0226 ($0.1157) |
| Agent time: median | 12.9 s | 9.6 s |
| Rejected replies | 0 in all | 0 in all |

Stage total: $0.271.

### T4 (course-001-ddmrv@v2, default obstacle: transient-test-failure)

Sources: [`ab-adaptive-context-v1.t4.results.json`](ab-adaptive-context-v1.t4.results.json),
[`ab-adaptive-context-v1.t4.diagnosis.md`](ab-adaptive-context-v1.t4.diagnosis.md) and
[`evidence/ab-adaptive-context-v1.t4.evidence.md`](evidence/ab-adaptive-context-v1.t4.evidence.md). 6 runs, commit
`e2f38d9`. The results JSON has no regression field; the regression outcomes come from the evidence file.

| Run (seq · arm) | Outcome | Hidden accept. | Regression | Calls / execs | Rejected replies | Total input | Uncached / cache read / cache write | Output | Cost | Agent time | Profiles | Agent status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 · replay | PASS | pass | pass (1678) | 47 / 38 | 8 | 2,961,993 | 62,544 / 2,804,951 / 94,498 | 39,845 | $2.08 | 594 s | replay | escalated, not verified |
| 2 · auto | PASS | pass | pass (1665) | 47 / 35 | 11 | 3,198,100 | 99,681 / 2,948,861 / 149,558 | 35,069 | $2.44 | 564 s | Deep 34, Standard 13 | escalated, not verified |
| 3 · auto | PASS | pass | pass (1672) | 46 / 39 | 6 | 3,139,869 | 97,552 / 2,941,936 / 100,381 | 35,494 | $2.19 | 591 s | Deep 32, Standard 14 | escalated, not verified |
| 4 · replay | PASS | pass | pass (1679) | 50 / 45 | 5 | 3,429,085 | 74,636 / 3,250,189 / 104,260 | 37,375 | $2.22 | 595 s | replay | limit_reached, not verified |
| 5 · replay | PASS | pass | pass (1679) | 46 / 37 | 8 | 3,000,775 | 60,026 / 2,830,573 / 110,176 | 34,770 | $2.05 | 526 s | replay | escalated, not verified |
| 6 · auto | **FAIL** (agent) | pass | **1 failed**, 1673 passed | 45 / 39 | 5 | 3,133,869 | 82,309 / 2,949,366 / 102,194 | 28,297 | $2.00 | 455 s | Deep 27, Standard 18 | escalated, not verified |

| Medians | replay | auto |
| --- | --- | --- |
| Total input | 3,000,775 | 3,139,869 (+4.6%) |
| Output | 37,375 | 35,069 (−6.2%) |
| Cost per run (stage sum) | $2.08 ($6.35) | $2.19 ($6.62) |
| Calls / executions | 47 / 38 | 46 / 39 |
| Agent time | 594 s | 564 s |
| Cache-read share of total input (pooled) | 94.6% | 93.3% |

- **Observed, recovery:** the injected obstacle was recognized and recovered in all 6 runs.
- **Observed, stage total:** $12.97.
- **Observed, scope:** these are 3 runs per arm, a screening stage under a strict stop rule, not proof.

### Earlier, separate baseline (not comparable with the A/B)

The plan's `baseline` field records the 2026-10-28 batch, which used a different configuration: Stack-Agent
`35d7af2`, no prompt caching, and `--no-state` on T4.
- Opus T4: 42 calls, 2,837,169 input and 31,054 output tokens.
- Sonnet T4: 48 calls, 3,437,273 input and 44,890 output tokens.
- Opus course-000 with transient-test-failure: 4 calls, 11,279 input and 726 output tokens.

The batch's own run records are not in this repository; only these summary figures are, and they must not be pooled
with the A/B.

## C. What we learned about context selection

- **Observed:** in all three `auto` T4 runs the selector switched Standard → Deep (at calls 14, 15 and 19) with
  "conflicting evidence: executions … answered the same request differently with no change by this work between or
  since".
  - The cited executions are the run's first two `pax.test` intents (`evidence/…t4.evidence.md`, from the durable
    intents in each run's `agent-state-show.json`).
  - In the PAX shim log, test #1 is the injected obstacle (`status error`, `reason transient-infrastructure-failure`)
    and test #2 is a real run (`status failed`).
  - The runs then stayed in Deep for 34/47, 32/46 and 27/45 calls.
- **Interpretation:** the selector treats a deliberately transient infrastructure error as conflicting evidence about
  the code. Deep adds sections to every later user message, which explains the extra uncached input:
  - `auto` median uncached input was 97,552 against 62,544 for replay;
  - cache-read volume was similar in both arms;
  - total input was +4.6%.
- **Proposed selector correction**, not implemented: an execution PAX itself classifies as a transient infrastructure
  failure (`status: error`, `reason: transient-infrastructure-failure`) does not count as conflicting evidence. Test
  failures, and a later real result that differs from an earlier real result, still do. Validation required:
  - an offline test with a scripted model replaying this sequence (transient error, then a real run), showing it
    stays in Standard;
  - existing tests showing genuine conflicts still escalate;
  - `replay` unchanged byte for byte;
  - then a controlled re-run (section I).
- **Why course-000 showed no input saving (interpretation):** each run makes 4–5 calls and never re-reads a file, so
  Standard has nothing to condense. It still adds its task-state section to every user message after the cache
  breakpoint, which is billed as uncached input (+866 median per run). Output fell, but output was not the primary
  metric and n=5.
  - The Stack-Agent docs (`docs/product/adaptive-context.md`, Known limitations) anticipated exactly this: "on a run
    that never re-reads a file it sends what `dedup-v1` sends plus the task-state section".
- **Why T4 established no improvement (interpretation):**
  - the Deep selections above dominated the `auto` runs;
  - one `auto` run failed, so the correctness gate was not cleanly met;
  - 3 runs per arm cannot separate a ±5% effect from run-to-run variation (replay total input ranged
    2.96M–3.43M).
- **Open question:** what `auto` does on T4 without the spurious escalation. This is unmeasured.

## D. Prompt caching

- **Observed:** with `--prompt-cache on`, cache reads were the large majority of total input, measured from pooled
  sums:
  - course-000: 80.4% (replay) and 77.9% (auto);
  - T4: 94.6% (replay) and 93.3% (auto).
  - Cache writes were ~1.1–1.2K tokens per course-000 run (3,160 on the first, cold run) and 94K–150K per T4 run.
- **Observed:** each cached T4 Opus run cost $2.00–$2.44.
- **Projection, not a controlled experiment:** the 2026-10-28 uncached Opus T4 run (2,837,169 input, 31,054 output)
  would cost about $11.97 at the same list prices. That run used a different build and `--no-state`, with caching
  off. The roughly 5× difference is indicative only.
- **Lesson:** total input-token volume and cost are different metrics. Cached tokens are still input tokens (the
  primary metric counts them) but are priced differently: in these runs cache reads were $0.20 against $4 per million
  for uncached input. A fall in uncached input alone is not an input-token reduction.
- **Source of the change:** the token-economics branch (`claude/peaceful-gates-zhpb4h` @ `aa72067`, commits `d86ae35`
  and `361ac17`) added the cache breakpoint and started reading Anthropic cache writes. The earlier build read neither,
  so historical `cache_write` values are unknown, not zero.

## E. Correctness and verification

- **Observed (seq 6, `auto`):** hidden acceptance 8/8 passed; regression 1 failed, 1673 passed. The failing test was
  `spec/test/behavioral-replacement-e2e.test.ts` > "independent Python provider: honest versus a ghost …", with
  `Error: python provider did not start`. The evaluator's FAIL stands.
- **Observed, local reruns after the stage** (`evidence/…t4.evidence.md`):
  - that test file alone: 5/5 pass on the pristine fixture `268c9b4`, and 5/5 with seq 6's diff;
  - the full suite: 3/3 pass on base and 4/4 with seq 5's diff (a passing replay run that changed the same two
    files), but 6/7 with seq 6's diff.
  - The one local failure was the same test with a different symptom: ``expected 'inconclusive' to be
    'equivalent-for-tested-scenarios'``.
- **Classification: inconclusive.** The failure was seen only with seq 6's change (2 of 8 full-suite runs, counting
  the evaluator's) and never without it (0/7). It could be a timing-sensitive behavior change from that specific
  resolver fix, or chance. It is not labelled harmless flakiness, and not a confirmed regression.
- **Observed:** in all 6 T4 runs:
  - the recorded audit snapshot failed (`spec/test/audit.test.ts` > "matches the checked-in machine-readable
    snapshot", 1 failed / 1 passed);
  - the agent's last own test run had exactly 1 failure.
  - Every agent diff adds a test file (`packages/core/test/multi-version-resolution.test.ts`).
- **Interpretation:** the audit snapshot lists every test file, so adding one fails it. The agent's `pax test` runs
  the full `pnpm test`, which includes the snapshot; the evaluator records it but excludes it from scoring. So after a
  correct fix the agent sees a failure the evaluator ignores, and rightly does not claim verification.
  - **Caveat:** PAX reports counts, not test names, so the agent's single failure is inferred to be the audit
    snapshot. It has not been confirmed per run.
- **Lesson:** keep the evaluator verdict and the agent's own completion/verification status as separate signals.
  - On course-000 they agreed (10/10 completed and verified, 10/10 PASS).
  - On T4 v2 they cannot agree, because of the contract mismatch.
  - Neither replaces the other: the evaluator is authoritative for correctness, and the agent's status is what the
    runtime can actually know.
- **Proposed:** a course-001 v3 with one explicit acceptance contract that the agent can see:
  - either the agent-visible test command excludes the audit snapshot as the evaluator does, or the goal requires
    keeping the snapshot current and the evaluator scores it;
  - with a fresh preflight (baseline must fail, reference must pass).
  - v2 and its results stay as recorded.

## F. Runtime and recovery

- **Observed, defect found in validation and fixed** on Stack-Agent `claude/adaptive-context` (commit `46344ae`,
  validated in `ab050d2`, documented in `docs/product/agent-state.md`).
  - Goals over FeltDB's 1,024-byte objective limit are stored as a bounded objective (prefix plus
    `[goal sha256:<digest>, <n> bytes; …]`), with the whole goal in the write-once admission record (≤16 KiB).
  - A continuation could pass that stored objective as its goal. Being within the limit, it is its own objective, so
    `begin` accepted it and the run would have continued with part of the goal.
  - `work_state::check_continuation` now requires the continuation's goal to equal the admission record's goal byte
    for byte, with the digest's length and hash. A legacy cut objective with no readable admission record is refused.
  - Tests: `crates/stack-agent/tests/objective_limit_durable.rs` uses the real 1,829-byte T4 goal (fixture
    `tests/fixtures/objective/t4-goal.txt`), kills a run, refuses a bad resume and resumes correctly. Unit tests in
    `work_state.rs` cover the boundaries, multi-byte UTF-8, 16 KiB, missing or corrupt records and legacy tasks.
  - Earlier cause, observed 2026-10-28: Stack-Agent persisted goals over 1,024 bytes in full, so every T4 run with
    durable state was refused (`FeltDB refused create_task: CONTRACT_INPUT_INVALID`). The A/B's T4 stage ran with
    durable state on and no such refusal: all 6 reports show `agent_state.recorded: true` in the run's own state
    database.
- **Observed, lease-renewal hazard:**
  - Stack-Agent renews the lease only before each execution ("each execution: renew; record_intent",
    `docs/product/agent-state.md`), never during or between model calls.
  - A probe with `--lease-secs 1` and a slow model call ended with `FeltDB refused checkpoint: LEASE_EXPIRED` (exit 4)
    after a write had executed ([`evidence/stack-agent-lease-gap-probe.out`](evidence/stack-agent-lease-gap-probe.out),
    source [`evidence/stack-agent-lease-gap-probe.rs`](evidence/stack-agent-lease-gap-probe.rs)).
  - **Hypothesis:** a long run of slow or rejected calls between executions could do the same at the 360 s lease the
    harness uses.
  - **Observed in the harness:** after a kill, the harness waits `leaseSecs + 2` (362 s) before relaunching
    (`harness/agents/stack-agent.mjs`). That wait is the ~6 minutes seen in course-000 interruption runs.
  - **Observed:** Stack-Agent (as of `35d7af2`) runs `pax test` in its own process group (harness commit `9af6e2c`
    had to kill the agent's group explicitly because of it), so a test can outlive the agent's killed group. That is
    why an early takeover is not simply safe.
- **Proposed, separate PR:** renew the lease on a heartbeat while a model call or tool is in flight, and clean up
  orphaned test process groups on takeover; only then shorten the lease. It is not bundled with context work, because
  it changes elapsed-time and recovery comparisons.

## G. Token-economics instrumentation

From the token-economics branch (`claude/peaceful-gates-zhpb4h` @ `aa72067`, `docs/product/token-usage.md`; the
`token-report` analysis of the historical Opus T4 run is in
[`evidence/stack-agent-token-report.opus-t4-historical.json`](evidence/stack-agent-token-report.opus-t4-historical.json)):

- **Observed:** per-call records made the problem visible.
  - Input grew from 2,482 tokens (call 1) to 101,180 (call 42), and requests were append-only.
  - Up to 2,735,989 tokens (96.4% of input) repeated the previous request. This is an upper bound derived from the
    counts, not a measured byte comparison.
  - The largest single step added 13,586 tokens, carried by 40 later calls.
- **Lessons:**
  - Measure per call, not per run: growth, repeated content and rejected or unproductive calls only show up at call
    level.
  - Keep cache read, cache write and uncached input separate with each provider's accounting rules (Anthropic's
    `input_tokens` excludes cache; OpenAI's `prompt_tokens` includes it). Unknown stays `null`, never 0; the harness
    stores a total only when every call reported the field.
  - Record the profile and the selection reason on every call. That is how the spurious Deep escalation was found
    in minutes.
  - Byte sizes and estimates are proxies; no saving is claimed without a controlled comparison.
- **Missing evidence:** a historical breakdown of unproductive calls for the A/B runs has not been mined yet (see
  section I.6). Rejected replies were 5–11 per T4 run in both arms.

## H. Experiment design lessons

- **Keep an exact legacy request (`replay`) as the default.** A first default of `auto` silently changed every request
  and broke the exact-request tests (`episodic_memory`, `episodic_serve`, `skill_experiment`). `replay` is now tested
  byte for byte against requests captured from `aa72067` (`tests/replay_equivalence.rs`).
- **Compare every failing test against the exact base.** The adaptive branch's apparent `pax_work`/`verify`
  regressions came from an exported `CARGO_TARGET_DIR`: they failed identically on base with it set. Five other
  failures already failed on base (`docs/product/adaptive-context.md`, Validation status).
- **Separate correctness gates from efficiency metrics.** The T4 `auto` FAIL is reported as a gate miss, not folded
  into a token average.
- **Isolate builds, worktrees and configurations.**
  - The A/B ran a named build in `~/.aoc-bins`, never the benchmark checkout's binary.
  - Each run records commit, sha256 and effective settings.
  - Building everywhere at once filled the disk once, so builds now cap their directories and check free space.
- **Use scripted or mock providers offline.**
  - The harness's arm wiring (`harness/test/stack-agent-config.test.mjs`) and Stack-Agent's profile behavior were
    validated with fake OpenAI-compatible and Anthropic servers before any spend.
  - A fake model that keyed conversations on a work id produced a false FAIL. Fakes need one conversation per server.
- **Pre-register metrics and stop rules.** The plan named the primary metric and decision rule before course-000.
  Secondary metrics and the strict T4 stop rule were added before any T4 result existed, and the plan records when.
- **Small samples screen; they do not prove.** 5+5 and 3+3 runs found one real selector defect and one contract
  mismatch, but cannot establish a ±5% efficiency effect.

## I. Ranked next experiments and changes

| # | Candidate | Evidence | Expected impact | Risk | Validation | Paid calls |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Selector: PAX-classified transient failures are not "conflicting evidence" | C; all 3 auto T4 runs | Removes most Deep use on T4; likely the largest part of auto's +4.6% input | Low: narrow rule; real conflicts still escalate | Offline scripted replay of the obstacle sequence; existing selector tests; replay byte-identical | No |
| 2 | Investigate the Python-provider failure | E; 2/8 with seq 6's diff vs 0/7 otherwise | Settles whether a correct-looking fix can be timing-unsafe; protects the gate | None to runtime | More full-suite runs of seq 6's diff vs base and other diffs; read the resolver change against `startPython` | No |
| 3 | course-001 v3 with one explicit acceptance contract (audit snapshot) | E; all 6 T4 runs | The agent's own completion and verification become meaningful on T4 | Low; v2 and its results stay | Preflight: baseline fails, reference passes; agent-visible suite and evaluator agree | No (preflight only) |
| 4 | Controlled replay vs auto re-run after 1–3 | B, C | First fair efficiency reading of auto on T4 | Spend; small sample | Same build except the selector fix, same course version (v3), cache on, ABBA, pre-registered; course-000 then T4 | **Yes** (T4 ≈ $13 per 3+3 at observed costs) |
| 5 | Lease heartbeat and orphaned test-process cleanup (separate PR) | F; probe, harness wait | Removes ~6 min per interruption; closes a lease-loss hazard | Medium: concurrency and duplicate execution | Offline: slow-call probe no longer loses the lease; kill and relaunch takes over promptly without duplicate effects | No |
| 6 | Mine the existing per-call traces (A/B and historical) | G | Quantifies rejected-reply cost and context growth per profile; targets the next optimization | None | `stack-agent token-report --json` on saved reports; compare by arm and profile | No |

## Sources

All in this repository unless noted.

- **Plan:** [`ab-adaptive-context-v1.json`](ab-adaptive-context-v1.json). Commits: `9151be3` (plan and harness),
  `733b9cb` and `c49d72f` (amendments).
- **course-000 results:** [`ab-adaptive-context-v1.course-000.results.json`](ab-adaptive-context-v1.course-000.results.json)
  (`d67904b`).
- **T4 results and diagnosis:** [`ab-adaptive-context-v1.t4.results.json`](ab-adaptive-context-v1.t4.results.json),
  [`ab-adaptive-context-v1.t4.diagnosis.md`](ab-adaptive-context-v1.t4.diagnosis.md) (`e2f38d9`).
- **Extracted T4 evidence** (audit snapshots, regression, PAX shim order, selector triggers, local reruns):
  [`evidence/ab-adaptive-context-v1.t4.evidence.md`](evidence/ab-adaptive-context-v1.t4.evidence.md). Generated from
  `~/.aoc/runs/<runId>` on the benchmark host; those run directories are not in the repository.
- **Lease probe:** [`evidence/stack-agent-lease-gap-probe.rs`](evidence/stack-agent-lease-gap-probe.rs) and
  [`.out`](evidence/stack-agent-lease-gap-probe.out).
- **Token report of the historical Opus T4 run:**
  [`evidence/stack-agent-token-report.opus-t4-historical.json`](evidence/stack-agent-token-report.opus-t4-historical.json).
  Its source is Stack-Agent fixture `crates/stack-agent/tests/fixtures/token_report/opus-t4-historical.json`.
- **Harness configuration:** [`../harness/agents/stack-agent-builds.json`](../harness/agents/stack-agent-builds.json),
  [`../harness/agents/stack-agent-config.mjs`](../harness/agents/stack-agent-config.mjs),
  [`../harness/test/stack-agent-config.test.mjs`](../harness/test/stack-agent-config.test.mjs),
  [`../docs/harness/README.md`](../docs/harness/README.md).
- **Stack-Agent** (rkendel1/stack-agent, not in this repository):
  - `claude/peaceful-gates-zhpb4h` @ `aa72067`: token economics (`d86ae35`, `361ac17`, `aa72067`).
  - `claude/adaptive-context` @ `4a9b05b`: adaptive context (`e04202f`, `3eb0b42`, `ed06459`, `5d201d2`) and
    validation (`46344ae`, `f6838eb`, `ab050d2`, `6f6e688`, `4a9b05b`).
  - Docs: `docs/product/token-usage.md`, `adaptive-context.md`, `agent-state.md`.

## Missing evidence and open questions

- **Per-test validation logs are not durable.** The adaptive-context validation's base-vs-branch logs exist only in a
  session scratch directory; the committed record is the summary in Stack-Agent's `docs/product/adaptive-context.md`.
- **The 2026-10-28 batch:** its per-run records are not in this repository, only the summary figures in the plan's
  `baseline` field.
- **The agent's single T4 test failure** is inferred to be the audit snapshot; PAX gives counts, not names.
- **The Python-provider failure** is unresolved (E).
- **`auto` without the spurious Deep escalation** is unmeasured (C).
- **Whether Standard's condensing of pre-edit file reads costs quality** is unmeasured
  (`docs/product/adaptive-context.md`, Known limitations).
- **Cache writes before `aa72067`** are unknown, not zero.
- **No dollar figure is reported by the provider;** every cost here is computed from token counts at the plan's
  prices. Check current pricing before reusing the figures.
