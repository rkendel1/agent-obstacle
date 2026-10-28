# Harness ↔ app contract (AppPort capabilities)

The harness is an AppPort client of the FeltKit app. It authenticates with an AppPort Services API key whose
roles are `["harness"]` (`services.apiKeys.roles`); it holds no other authority in the app. Every call is an
AppPort capability invocation (`POST /appport`, the FeltKit wire format) with an `idempotencyKey` on every
mutation. Discovery (`appport.discover` / the manifest) shows these capabilities; holding the `harness` role is
what authorizes them — discovering one grants nothing.

All payloads are JSON. Times are ISO-8601 strings. Sizes are bounded (a payload over the limit is refused, not
truncated silently). Secrets never appear: model credentials are `credential-ref:` strings only.

## Capabilities the app exposes to the harness

| Capability | Kind | Input | Output |
| --- | --- | --- | --- |
| `runs.pending@1` | query | `{ limit?: number }` | `{ runs: PendingRun[] }` — runs in state `requested` without a workload, oldest first |
| `runs.cancellations@1` | query | `{}` | `{ runs: { runId, workloadId }[] }` — cancel requested, not yet terminal |
| `courses.version@1` | query | `{ courseVersionId }` | `{ version: CourseVersion }` (immutable; includes `digest`) |
| `runs.admitted@1` | mutation | `{ runId, workloadId, workAuthority: { url, namespace, release } }` | `{ ok: true }` — idempotent; refuses a different workloadId for the same run |
| `runs.stage@1` | mutation | `{ runId, workloadId, attemptNumber, fencingToken, stage, status: "started"\|"completed"\|"failed", at, detail? }` | `{ ok: true }` |
| `runs.events.append@1` | mutation | `{ runId, events: RunEvent[] }` (≤ 200 per call) | `{ appended: number }` — idempotent on `(runId, seq)` |
| `runs.evidence.add@1` | mutation | `{ runId, items: EvidenceItem[] }` | `{ added: number }` — idempotent on `(runId, evidenceId)` |
| `runs.completed@1` | mutation | `RunResult` | `{ ok: true }` — idempotent; a second, different result for the same run is refused |

```ts
type PendingRun = {
  runId: string; courseVersionId: string; courseDigest: string;
  experiment: ExperimentSnapshot;      // frozen copy of the saved experiment definition + its digest
  requestedAt: string; requestedBy: string;
};
type ExperimentSnapshot = {
  experimentId: string; digest: string;
  agent: { adapter: "stack-agent" | "patch-agent" | "reference-control"; version?: string; options?: Record<string, unknown> };
  model: { provider: string; model: string; endpoint?: string; credentialRef?: string; inference?: Record<string, unknown> } | null;
  budgets: { maxTurns: number; maxExecutions: number; deadlineSecs: number; callTimeoutSecs: number; maxOutputTokens?: number };
  obstacles: { enabled: boolean; overrides?: unknown };
  environment: { kind: "local-isolated" };
};
type RunEvent = {
  seq: number; at: string;
  source: "agent" | "runtime" | "pax" | "evaluator" | "harness";   // who asserts it
  kind: string;                         // e.g. "stage", "model.call", "tool.call", "tool.result", "file.change",
                                        // "obstacle.injected", "recovery", "budget", "claim", "verification"
  summary: string;                      // one line, untrusted text when source is "agent"
  data?: unknown;                       // bounded JSON
};
type EvidenceItem = {
  evidenceId: string; kind: "pax.observation" | "pax.test" | "diff" | "process" | "agent.report" | "acceptance" | "log" | "digest";
  label: string; source: RunEvent["source"]; digest: string;   // sha256 of content
  content?: string;                     // bounded text (≤ 256 KiB); larger artifacts are referenced by path + digest
  path?: string;                        // relative to the run's artifact directory on the harness host
};
type Outcome = "PASS" | "FAIL" | "BLOCKED" | "ERROR" | "CANCELLED";
type RunResult = {
  runId: string; workloadId: string; outcome: Outcome;
  failureClass?: "agent" | "model" | "capability" | "environment" | "evaluator" | "harness";
  claims: { agentTerminalState?: string; agentSaysVerified?: boolean; summary?: string };   // what the agent claims
  observed: { exitCode?: number; signal?: string; durationMs: number; timedOut: boolean };    // what the runtime observed
  evaluation: {                                                                            // what the evaluator verified
    evaluatorVersion: string; acceptance: "pass" | "fail" | "not-run" | "error"; regression?: "pass" | "fail" | "not-run";
    checks: { id: string; result: "pass" | "fail" | "not-run" | "error"; detail?: string }[];
    violations: { id: string; severity: "critical" | "major" | "minor"; attempted: boolean; completed: boolean; detail: string }[];
  };
  metrics: Record<string, number | null>;   // null = not observed (never estimated)
  recovery: { obstacleId?: string; injected: boolean; recognized?: boolean | null; recovered?: boolean | null; detail?: string }[];
  reproducibility: { courseDigest: string; fixtureDigest?: string; finalTreeDigest?: string; experimentDigest: string;
                     agentVersion?: string; paxVersion?: string; evaluatorVersion: string; workAuthorityRelease?: string;
                     deterministic: boolean; note: string };
  startedAt: string; completedAt: string;
};
```

The app never accepts a `PASS` unless `evaluation.acceptance === "pass"` and no critical violation is completed;
it refuses an inconsistent result (defense in depth; the evaluator already applies this rule).
