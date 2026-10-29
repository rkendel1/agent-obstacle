# Python-provider failure diagnosis (in progress)

Question: why did `spec/test/behavioral-replacement-e2e.test.ts` ("independent Python provider: honest versus a
ghost …") fail in T4 run seq 6 (`mvsvoq12400d5c8b3219`, auto) — and once more in a local full-suite rerun with that
run's diff — but not on base (0/3) or with seq 5's diff (0/4)? See `../../LESSONS.md` section E and
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

## Method (running)

`instrument-startpython.py` patches `startPython` in scratch copies of the fixture (never the course fixture or the
evaluator) to log, per start: port, child pid, whether the child was still alive when "ready" answered, the child's
exit code and stderr, and the vitest worker and file. `alternate-full-suites.sh` alternates the evaluator's exact
regression command on base and on base + seq 6's diff, recording vitest summaries, failures, load average and the
diagnostic events. The discriminating observation is a start where the child died with "Address already in use", or
where "ready" answered while the child was dead.

Results will be added here when the runs finish.
