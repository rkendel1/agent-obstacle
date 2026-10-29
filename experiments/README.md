# Experiments

Pre-registered experiment plans, their recorded results, and the evidence extracted from runs. Result files are
records: they are never edited after the fact.

**What we have learned so far: [LESSONS.md](LESSONS.md)** — the canonical summary; start there.

| File | What it is |
| --- | --- |
| [`ab-adaptive-context-v1.json`](ab-adaptive-context-v1.json) | Plan: Stack-Agent `replay` vs `auto` (pre-registered; amendments recorded in the file) |
| [`ab-adaptive-context-v1.course-000.results.json`](ab-adaptive-context-v1.course-000.results.json) | Results, course-000 stage (10 runs) |
| [`ab-adaptive-context-v1.t4.results.json`](ab-adaptive-context-v1.t4.results.json) | Results, T4 stage (6 runs) |
| [`ab-adaptive-context-v1.t4.diagnosis.md`](ab-adaptive-context-v1.t4.diagnosis.md) | Diagnosis notes written with the T4 results |
| [`evidence/`](evidence/) | Evidence extracted from run directories and probes that are not otherwise in the repository |

Run a plan with `npm run experiment:ab` (dry run by default; see [`../docs/harness/README.md`](../docs/harness/README.md)).
