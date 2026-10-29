# Experiment lessons: the Agent Obstacle Course side

What the experiments run through this harness have taught us about **the course, the evaluator, the harness and how
we run experiments**. Findings about Stack-Agent itself are recorded in the Stack-Agent repository, where they belong:
rkendel1/stack-agent `docs/product/efficiency-experiments.md` (branch `claude/efficiency-findings`). That page covers
token economics, prompt caching, the adaptive-context selector, durable state and leases, together with the
measured results of `ab-adaptive-context-v1`.

The original run records stay here, unedited: the plan [`ab-adaptive-context-v1.json`](ab-adaptive-context-v1.json),
[`ab-adaptive-context-v1.course-000.results.json`](ab-adaptive-context-v1.course-000.results.json),
[`ab-adaptive-context-v1.t4.results.json`](ab-adaptive-context-v1.t4.results.json),
[`ab-adaptive-context-v1.t4.diagnosis.md`](ab-adaptive-context-v1.t4.diagnosis.md) and
[`evidence/ab-adaptive-context-v1.t4.evidence.md`](evidence/ab-adaptive-context-v1.t4.evidence.md). Stack-Agent holds
byte-for-byte copies with provenance (origin, commit, sha256).

Labels: **Observed** (read from a saved artifact), **Interpretation**, **Hypothesis**, **Proposed** (not
implemented).

## 1. Course-001 (T4) v2: the agent cannot verify what the evaluator accepts

- **Observed:** in all 6 T4 runs of `ab-adaptive-context-v1`:
  - the evaluator's recorded audit snapshot failed (`spec/test/audit.test.ts` > "matches the checked-in
    machine-readable snapshot");
  - the agent's last own test run had exactly 1 failure;
  - the agent never reported `verified`, including on the 5 evaluator PASSes.
  - Every agent diff added a test file ([`evidence/…t4.evidence.md`](evidence/ab-adaptive-context-v1.t4.evidence.md)).
- **Interpretation:** the audit snapshot lists every test file, so adding one breaks it. The agent's `pax test` runs
  the full `pnpm test`, which includes the snapshot. The evaluator records it but excludes it from scoring (course
  v2 `acceptance.recordOnly` and the regression command's `--exclude spec/test/audit.test.ts`). The agent therefore
  sees a failure the evaluator ignores, and rightly does not claim verification.
  - **Caveat:** PAX gives counts, not test names, so the agent's single failure is inferred to be the snapshot.
- **Proposed: course-001 v3** with one acceptance contract the agent can see. Either:
  - the agent-visible test command excludes the snapshot, as the evaluator does; or
  - the goal asks for the snapshot to be kept current, and the evaluator scores it.

  Fresh preflight (baseline must fail, reference must pass). v2 and its results stay as recorded.
- **Lesson:** keep the evaluator verdict and the agent's own status as separate signals in every report. They agreed
  on course-000 (10/10) and could not agree on T4 v2.

## 2. Course fixture: the Python-provider test failure (unresolved)

- **Observed:** T4 seq 6 (`auto`, run `mvsvoq12400d5c8b3219`) passed 8/8 hidden acceptance tests but failed one
  regression test: `spec/test/behavioral-replacement-e2e.test.ts` > "independent Python provider …", with
  `Error: python provider did not start`. The evaluator's FAIL stands.
- **Observed, local reruns:**
  - that test file alone: 5/5 pass on the pristine fixture `268c9b4`, and 5/5 with seq 6's diff;
  - the full suite: 3/3 pass on base and 4/4 with seq 5's diff, but 6/7 with seq 6's diff;
  - the local failure had a different symptom: ``expected 'inconclusive' to be 'equivalent-for-tested-scenarios'``.
- **Classification: inconclusive.** Not labelled harmless flakiness, not a confirmed regression.
- **Investigation in progress:** [`evidence/python-provider-diagnosis/`](evidence/python-provider-diagnosis/README.md).
  - The two diffs carry the same resolver logic.
  - **Hypothesis:** the course fixture's `freePort()` → `startPython()` port race explains both symptoms. It is the
    mechanism already documented for `integration-e2e.test.ts` in the course's `knownFlaky` note.
  - Instrumented runs are under way.
- **Lesson:** a course whose regression suite contains timing-sensitive end-to-end tests can fail correct work. Each
  such test needs either a deterministic fixture or an explicit, evidenced `knownFlaky` treatment, decided in a new
  course version, never after seeing results.

## 3. The harness

- **Run the exact build.** Experiments select a named build (`agent.options.build` →
  [`../harness/agents/stack-agent-builds.json`](../harness/agents/stack-agent-builds.json)), never the benchmark
  checkout's binary. Each run records commit, sha256, the requested settings and the **effective** settings read
  from the agent's own report. Unsupported options are refused before the agent starts, never dropped.
- **Unknown is not zero.** Token totals are stored only when every call reported the field; otherwise they are
  `null`.
- **Validate arms offline first.**
  - [`../harness/test/stack-agent-config.test.mjs`](../harness/test/stack-agent-config.test.mjs) runs both arms
    against fake OpenAI-compatible and Anthropic servers that record every request.
  - A fake model that keyed conversations on a work id produced a false FAIL (`auto` deliberately removes that id
    from the request), so fakes serve one conversation per server.
- **The process-interruption obstacle must kill the agent's own process group.** Stack-Agent runs `pax test` in a
  group of its own, so killing the shim's group was not enough (fixed in `9af6e2c`).
- **Interruption timing:** after a kill the harness waits the agent's lease + 2 s (362 s for a 360 s lease). That
  dominates elapsed time, so interruption obstacles were excluded from the A/B. The lease itself is a Stack-Agent
  matter (see its page).
- **The single start command stops leftovers of its own checkout** and never its own parent processes. A second
  harness for the same checkout is refused (`.harness/harness.pid`).
- **Known app issue:** FeltKit logged `state.lock EEXIST` and briefly reset a request with only one app process
  running. The harness retried successfully. It is a FeltKit issue, still open.

## 4. Running experiments

- **Pre-register:** the primary metric, secondary metrics, hard constraints and stop rule go in the plan
  (`npm run experiment:ab` dry-runs it: exact definitions, ABBA order, projected calls and cost). Amendments are
  recorded with their time relative to the first result. `ab-adaptive-context-v1`'s metric amendment was made after
  launch and before any T4 result.
- **Correctness gates are separate from efficiency metrics.** A FAIL is reported as a gate miss, never averaged
  into tokens.
- **Small samples screen.** 5+5 and 3+3 runs found a selector defect and a course contract mismatch, but cannot
  resolve a ±5% effect.
- **Cost check:** the projected range (T4 $11–$72) was wide because the baseline had no caching. The real T4 stage
  cost $12.97, computed from provider-reported token counts at the plan's prices; Anthropic reports no dollar figure.

## 5. Next steps on this side

| # | Step | Evidence | Paid calls |
| --- | --- | --- | --- |
| 1 | Finish the Python-provider diagnosis (instrumented runs; fix the fixture's port handling in a new course version if the race is confirmed) | §2 | No |
| 2 | Course-001 v3 with one acceptance contract for the audit snapshot, with fresh preflight | §1 | No |
| 3 | Re-run `replay` vs `auto` once Stack-Agent's selector fix and course v3 exist (Stack-Agent page, next steps) | both pages | **Yes** (T4 ≈ $13 per 3+3 at observed costs) |

## Missing evidence

- The 2026-10-28 batch exists here only as the plan's `baseline` summary figures.
- The run directories (`~/.aoc/runs/<runId>`) are not in the repository; [`evidence/`](evidence/) holds what was
  extracted from them.
