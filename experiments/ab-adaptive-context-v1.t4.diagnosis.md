# ab-adaptive-context-v1, stage t4 — diagnosis notes

Six runs, Opus 5.5, prompt cache on, durable state on, build adaptive-4a9b05b. Results: `ab-adaptive-context-v1.t4.results.json`.

## The one FAIL (seq 6, auto, run mvsvoq12400d5c8b3219)

Evaluator verdict stands (FAIL, failure class agent): hidden acceptance 8/8 passed; regression 1673 passed, 1 failed —
`spec/test/behavioral-replacement-e2e.test.ts > independent Python provider: honest versus a ghost …`
(`Error: python provider did not start`).

Reproduction on the pristine fixture (base) and with this run's diff (agent), plus the diff of a passing replay run
(seq 5) that changed the same two files:

| Tree | That test file alone | Full regression suite (evaluator's command) |
| --- | --- | --- |
| base 268c9b4 | 5/5 pass | 3/3 pass |
| seq 6 diff | 5/5 pass | 6/7 pass — 1 fail in the same test, different symptom (`expected 'inconclusive' to be 'equivalent-for-tested-scenarios'`) |
| seq 5 diff | — | 4/4 pass |

Classification: **inconclusive**. The failure is intermittent and was seen only with seq 6's change (2 of 8 full-suite
runs including the evaluator's), never on base (0/3) or with another passing change (0/4). It could be a
timing-sensitive behaviour change from this specific resolver fix (the test compares capability resolution across a
second Python provider) or chance. Not relabelled; the evaluator result is authoritative.

## Why auto ran Deep for most of each run

In every auto run, the selector moved Standard → Deep at call 14–19 with "conflicting evidence: executions … answered
the same request differently with no change by this work". The pair is the course's injected transient test failure
(pax test #1: exit 75, status error) and the next, real test run (#2: tests failed). The obstacle is designed to
answer the same request differently; the selector treats it as conflicting evidence and the run stays in Deep for
27–34 of ~46 calls. Selector defect candidate: an execution PAX itself labels `transient-infrastructure-failure` should
not count as conflicting evidence.

## Why the agent never verifies on T4 (both arms)

Every run's agent reported `escalated` (one `limit_reached`) with verified=false, including the 5 evaluator PASSes.
Its own `pax test` runs the project's full `pnpm test`, which includes `spec/test/audit.test.ts`; that snapshot lists
every test file, so any change that adds a test fails it (`appport audit > matches the checked-in machine-readable
snapshot`). The evaluator records that snapshot but excludes it from scoring. So the agent sees 1 failing test after
its change in every run and correctly refuses to claim verification. This is a course/agent-visibility mismatch, not
an agent defect: the agent cannot know the audit snapshot is out of scope.
