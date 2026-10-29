# Python-provider failure diagnosis

Question: why did `spec/test/behavioral-replacement-e2e.test.ts` ("independent Python provider: honest versus a
ghost …") fail in T4 run seq 6 (`mvsvoq12400d5c8b3219`, auto) — and once more in a local full-suite rerun with that
run's diff — but not on base (0/3) or with seq 5's diff (0/4)? See `../../LESSONS.md` section 2 and
`../ab-adaptive-context-v1.t4.evidence.md`.

## Established so far

- **Exact diffs.** Seq 6's change is the evaluator's `eval/agent.diff` for that run (identical to the recorded
  `artifacts/diff_agent.txt`; sha256 prefix `6ec97de69613a722`). Seq 5's is `49899b37e9d61bb7`. Both change
  `packages/core/src/resolver.ts` and add `packages/core/test/multi-version-resolution.test.ts`. Their resolver logic
  is the same — both select the highest provided version that satisfies the constraint — and they differ only in
  comments, variable names and the wording of one error message. A code defect specific to seq 6 is therefore
  unlikely, but not excluded.
- **The test's process lifecycle** (`spec/test/support/work-order-fixtures.ts`, fixture `268c9b4`): `freePort()` opens
  an ephemeral port, reads it and closes it; `startPython()` then spawns `server.py --port <that port>` and polls
  `/.well-known/appport` 100 × 50 ms (~5 s). `integration-e2e.test.ts` and `agent-planning-e2e.test.ts` start the
  same server the same way, in other vitest workers. The Python server binds with `SO_REUSEADDR`, which does not
  allow binding a port someone else is listening on.
- **Hypothesis (to be tested, not established):** a port race between `freePort()` closing the port and the child
  binding it explains both observed symptoms — if the port is taken by a non-AppPort listener the child dies and
  nothing answers (`python provider did not start`); if it is taken by another test's Python server the test talks
  to that server's state (`expected 'inconclusive' to be 'equivalent-for-tested-scenarios'`). This is the mechanism
  already documented for `integration-e2e.test.ts` in the course's `knownFlaky` note.
- **Single-file baseline:** with instrumentation, Python answers in ~110–130 ms (`smoke-single-file.pydiag.jsonl`),
  so the ~5 s budget is not tight when the child is alive.

## Method

`instrument-startpython.py` patches `startPython` in scratch copies of the fixture (never the course fixture or the
evaluator) to log, per start: port, child pid, whether the child was still alive when "ready" answered, the child's
exit code and stderr, and the vitest worker and file. Two experiments, alternating base (`268c9b4`) and base + seq 6's
diff ("d6"):

1. [`alternate-full-suites.sh`](alternate-full-suites.sh): the evaluator's exact regression command, 8 runs per tree,
   with machine load rising from 0.15 to 6.8 (a Stack-Agent build ran in parallel for part of it). Output:
   [`full-suites.out`](full-suites.out).
2. [`provoke-port-churn.sh`](provoke-port-churn.sh): only the three Python e2e files, 10 runs per tree, while
   [`port-churn.mjs`](port-churn.mjs) keeps 64 listeners cycling through ephemeral ports (300 ms each, ~27,000
   listeners in total) so that a port `freePort()` has just closed is likely to be taken before Python binds it.
   Output: [`provoke.out`](provoke.out).

## Results

- **Observed, full suites:** 16/16 passed (base 8/8, d6 8/8). 575 instrumented Python starts: every child was alive
  when "ready" answered, none failed to start, none reported "Address already in use"; ready took ~55–130 ms.
- **Observed, port churn:** 19/20 passed (base 10/10, d6 9/10). The one failure (d6 run 5) was **not** the T4
  symptom: `integration-e2e.test.ts` > "a provider that answers ok without producing the effect is detected as
  unverified" timed out after 20 s. Its `startPython(["--ghost"])` logged neither "ready" nor "did not start". All
  14 other starts in that run were alive and answered in 55–113 ms. `behavioral-replacement-e2e.test.ts` passed in
  all 20 runs.
- **Interpretation:** a start that never returns within 20 s is what the race predicts when the port is taken by
  a listener that accepts connections but never answers HTTP, as the churn listeners do: the readiness `fetch`
  hangs instead of failing. So the race is real but needs artificial pressure (1 hit in ~320 starts under churn,
  0 in 575 without it). It is also not tree-specific: it hit the test file the course already marks `knownFlaky`,
  and d6 does not touch the fixture.
- **Tally for the T4 failure itself** (`behavioral-replacement-e2e.test.ts`, "python provider did not start" or the
  `inconclusive` assertion): d6 2 failures in 31 full or targeted runs (the evaluator's, plus 1 of 7 earlier local
  full suites; 0 of 8 instrumented; 0 of 10 under churn; 0 of 5 single-file). Base 0 in 26. Seq 5's diff 0 of 4.
  The 2-vs-0 difference is not statistically meaningful at these counts (Fisher exact, two-sided p ≈ 0.50).

## Conclusion

- **No defect established in seq 6's change.** The resolver logic matches seq 5's, which passed. Nothing in the 36
  instrumented runs reproduced the T4 symptom on either tree.
- **The port-race hypothesis is weakened, not confirmed:** without injected churn every child bound its port. Under
  churn the race produced a third symptom (a hang), not either observed one. The original failures had a cause these
  runs did not reproduce.
- **Classification stays inconclusive.** The evaluator's FAIL for seq 6 stands; nothing here justifies rescoring it.
- **Fixture weaknesses that are real regardless** (for a future course version, decided before any results): the
  readiness `fetch` has no timeout, so a wrong listener hangs the test instead of failing fast; `freePort()` →
  spawn leaves a window; the readiness check does not confirm that the answering process is the child (e.g. by
  pid or a per-start token). Fixing these needs a new course version, so it is not done here.

## Next discriminating test

Capture the failure when it happens rather than trying to reproduce it locally. In the next course version's fixture
(or an instrumented evaluator copy, never the scoring path), record on every `startPython` failure the child's exit
code and stderr, and on every `inconclusive` verdict the per-scenario observations that produced it, then run the
regression suite under the harness's real conditions (concurrent runs, the worker's environment) for ≥ 30 runs per
tree. "Address already in use" in the child's stderr, or a scenario answered by a different pid, confirms the race;
a clean child with a wrong verdict points at the test's own scenario logic.
