/**
 * Schemas for the harness ↔ app contract (docs/contracts/harness-app.md).
 */
import { s } from "@feltdb/feltkit";

export const SOURCES = ["agent", "runtime", "pax", "evaluator", "harness"] as const;
export const OUTCOMES = ["PASS", "FAIL", "BLOCKED", "ERROR", "CANCELLED"] as const;
export const FAILURE_CLASSES = ["agent", "model", "capability", "environment", "evaluator", "harness"] as const;
export const ADAPTERS = ["stack-agent", "patch-agent", "reference-control"] as const;
export const EVIDENCE_KINDS = ["pax.observation", "pax.test", "diff", "process", "agent.report", "acceptance", "log", "digest"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const open = { additionalProperties: true } as const;

export const AgentSpec = s.object({
  adapter: s.enum(ADAPTERS),
  version: s.optional(s.string({ maxLength: 80 })),
  options: s.optional(s.record(s.unknown())),
});

export const ModelSpec = s.nullable(
  s.object({
    provider: s.string({ minLength: 1, maxLength: 80 }),
    model: s.string({ minLength: 1, maxLength: 200 }),
    endpoint: s.optional(s.string({ maxLength: 500 })),
    credentialRef: s.optional(s.string({ pattern: "^credential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" })),
    inference: s.optional(s.record(s.unknown())),
  }),
);

export const Budgets = s.object({
  maxTurns: s.integer({ minimum: 1, maximum: 10_000 }),
  maxExecutions: s.integer({ minimum: 1, maximum: 10_000 }),
  deadlineSecs: s.integer({ minimum: 1, maximum: 86_400 }),
  callTimeoutSecs: s.integer({ minimum: 1, maximum: 3_600 }),
  maxOutputTokens: s.optional(s.integer({ minimum: 1, maximum: 1_000_000 })),
});

export const Obstacles = s.object({ enabled: s.boolean(), overrides: s.optional(s.unknown()) });
export const Environment = s.object({ kind: s.literal("local-isolated") });

/** The digest-covered part of an experiment. */
export const DefinitionShape = {
  agent: AgentSpec,
  model: ModelSpec,
  budgets: Budgets,
  obstacles: Obstacles,
  environment: Environment,
};
export const Definition = s.object(DefinitionShape);

export const ExperimentSnapshot = s.object({ experimentId: s.string(), digest: s.string(), ...DefinitionShape });

export const PendingRun = s.object({
  runId: s.string(),
  courseVersionId: s.string(),
  courseDigest: s.string(),
  experiment: ExperimentSnapshot,
  requestedAt: s.string(),
  requestedBy: s.string(),
});

export const RunEvent = s.object({
  seq: s.integer({ minimum: 0 }),
  at: s.string({ minLength: 1, maxLength: 40 }),
  source: s.enum(SOURCES),
  kind: s.string({ minLength: 1, maxLength: 64 }),
  summary: s.string({ maxLength: 2000 }),
  data: s.optional(s.unknown()),
});

export const EvidenceItem = s.object({
  evidenceId: s.string({ minLength: 1, maxLength: 120 }),
  kind: s.enum(EVIDENCE_KINDS),
  label: s.string({ minLength: 1, maxLength: 300 }),
  source: s.enum(SOURCES),
  digest: s.string({ minLength: 1, maxLength: 80 }),
  content: s.optional(s.string()),
  path: s.optional(s.string({ maxLength: 500 })),
});

const CheckResult = s.enum(["pass", "fail", "not-run", "error"]);

/** RunResult as a function argument shape (top level is strict; nested objects accept extra fields). */
export const RunResultShape = {
  runId: s.string(),
  workloadId: s.string(),
  outcome: s.enum(OUTCOMES),
  failureClass: s.optional(s.enum(FAILURE_CLASSES)),
  claims: s.object(
    { agentTerminalState: s.optional(s.string({ maxLength: 200 })), agentSaysVerified: s.optional(s.boolean()), summary: s.optional(s.string({ maxLength: 8000 })) },
    open,
  ),
  observed: s.object(
    { exitCode: s.optional(s.integer()), signal: s.optional(s.string({ maxLength: 40 })), durationMs: s.number({ minimum: 0 }), timedOut: s.boolean() },
    open,
  ),
  evaluation: s.object(
    {
      evaluatorVersion: s.string({ minLength: 1, maxLength: 80 }),
      acceptance: CheckResult,
      regression: s.optional(s.enum(["pass", "fail", "not-run"])),
      checks: s.array(s.object({ id: s.string({ maxLength: 200 }), result: CheckResult, detail: s.optional(s.string({ maxLength: 8000 })) }, open), { maxItems: 500 }),
      violations: s.array(
        s.object(
          { id: s.string({ maxLength: 200 }), severity: s.enum(["critical", "major", "minor"]), attempted: s.boolean(), completed: s.boolean(), detail: s.string({ maxLength: 8000 }) },
          open,
        ),
        { maxItems: 500 },
      ),
    },
    open,
  ),
  metrics: s.record(s.nullable(s.number())),
  recovery: s.array(
    s.object(
      {
        obstacleId: s.optional(s.string({ maxLength: 200 })),
        injected: s.boolean(),
        recognized: s.optional(s.nullable(s.boolean())),
        recovered: s.optional(s.nullable(s.boolean())),
        detail: s.optional(s.string({ maxLength: 8000 })),
      },
      open,
    ),
    { maxItems: 200 },
  ),
  reproducibility: s.object(
    {
      courseDigest: s.string(),
      fixtureDigest: s.optional(s.string()),
      finalTreeDigest: s.optional(s.string()),
      experimentDigest: s.string(),
      agentVersion: s.optional(s.string()),
      paxVersion: s.optional(s.string()),
      evaluatorVersion: s.string(),
      workAuthorityRelease: s.optional(s.string()),
      deterministic: s.boolean(),
      note: s.string({ maxLength: 4000 }),
    },
    open,
  ),
  startedAt: s.string(),
  completedAt: s.string(),
};

/** The CourseVersion the harness reads (courses.version@1). */
export const CourseVersionOut = s.object({
  courseVersionId: s.string(),
  courseId: s.string(),
  version: s.string(),
  ref: s.string(),
  status: s.enum(["draft", "published"]),
  digest: s.string(),
  publishedAt: s.nullable(s.string()),
  spec: s.unknown(),
});

export const Ok = s.object({ ok: s.literal(true) });
