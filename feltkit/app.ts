/**
 * Agent Obstacle Course: the application, its roles, and its data.
 *
 * Everything lives in this environment's single FeltDB instance (development:
 * .feltkit/development/state). The run lifecycle itself is owned by FeltDB Durable Work
 * on feltdb-server, driven by the harness; `runs` here is the app's projection of it and
 * changes only through the harness capabilities (feltkit/harness.ts), except for the
 * three things a person may do: request a run, request a cancel, and rerun.
 *
 * See docs/ARCHITECTURE.md and docs/contracts/harness-app.md.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "agent-obstacle-course",
  version: "1.0.0",
  description:
    "Agent Obstacle Course: evaluate whole agent systems on real tasks under controlled conditions. Records what the agent claimed, what the runtime observed, and what an independent evaluator verified.",
  roles: {
    // Everything, including publishing course versions, API keys, Intelligence and Configuration.
    admin: ["*"],
    // Configure, launch, cancel, rerun, compare, view. Drafts course versions; cannot publish.
    developer: [
      "courses.read",
      "courses.draft",
      "experiments.read",
      "experiments.write",
      "runs.read",
      "runs.launch",
      "runs.cancel",
      "models.read",
      "feltkit.agent.read",
    ],
    // Read only.
    viewer: ["courses.read", "experiments.read", "runs.read", "models.read"],
    // The harness (an AppPort Services API key): the contract capabilities, nothing else.
    harness: ["harness.*"],
  },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["developer"] },
      { id: "linus", name: "Linus Torvalds", roles: ["viewer"] },
    ],
  },
  services: {
    // Every API key authenticates as an identity holding exactly these roles.
    apiKeys: { roles: ["harness"] },
    intelligence: true,
    configuration: true,
  },
});

/** A course: the stable identity that versions belong to. */
export const courses = app.collection(
  "courses",
  {
    courseId: s.string({ minLength: 1, maxLength: 80 }),
    name: s.string({ maxLength: 200 }),
    description: s.string({ maxLength: 4000 }),
    latestPublishedVersionId: s.optional(s.string()),
    latestPublishedVersion: s.optional(s.string()),
    publishedCount: s.integer({ minimum: 0 }),
    createdAt: s.number(),
    createdBy: s.string(),
    updatedAt: s.number(),
  },
  { description: "Courses. One record per course id; versions are in courseVersions." },
);

/**
 * A course version. Drafts may be edited; a published version is immutable: no
 * mutation in this app changes any field of a record whose status is "published".
 */
export const courseVersions = app.collection(
  "courseVersions",
  {
    courseId: s.string(),
    version: s.string({ minLength: 1, maxLength: 40 }),
    /** `${courseId}@${version}`; unique. */
    ref: s.string(),
    status: s.enum(["draft", "published"]),
    /** sha256 of the canonical JSON of `spec`. */
    digest: s.string(),
    /** The course.json document (evaluator files are never sent to the app). */
    spec: s.unknown(),
    name: s.string(),
    description: s.string(),
    kind: s.enum(["deterministic", "randomized", "adversarial"]),
    difficulty: s.string(),
    skills: s.array(s.string()),
    expectedRuntimeSecs: s.optional(s.number()),
    derivedFrom: s.optional(s.string()),
    createdAt: s.number(),
    createdBy: s.string(),
    updatedAt: s.number(),
    publishedAt: s.optional(s.number()),
    publishedBy: s.optional(s.string()),
  },
  { description: "Course versions. Published versions are immutable." },
);

/**
 * A saved experiment definition. Each record is one immutable revision; editing an
 * experiment creates a new revision with the same lineageId.
 */
export const experiments = app.collection(
  "experiments",
  {
    lineageId: s.string(),
    revision: s.integer({ minimum: 1 }),
    latest: s.boolean(),
    name: s.string({ minLength: 1, maxLength: 120 }),
    notes: s.optional(s.string({ maxLength: 4000 })),
    /** sha256 of the canonical JSON of `definition`. */
    digest: s.string(),
    /** { agent, model, budgets, obstacles, environment } (contract ExperimentSnapshot minus ids). */
    definition: s.unknown(),
    adapter: s.string(),
    modelLabel: s.string(),
    defaultCourseVersionId: s.optional(s.string()),
    createdAt: s.number(),
    createdBy: s.string(),
  },
  { description: "Experiment definitions (immutable revisions)." },
);

/** The app's projection of one attempt. The authority is Durable Work (workloadId). */
export const runs = app.collection(
  "runs",
  {
    courseId: s.string(),
    courseVersionId: s.string(),
    courseRef: s.string(),
    courseDigest: s.string(),
    experimentId: s.string(),
    experimentLineageId: s.string(),
    experimentDigest: s.string(),
    /** Frozen ExperimentSnapshot. */
    experiment: s.unknown(),
    adapter: s.string(),
    modelLabel: s.string(),
    state: s.enum(["requested", "admitted", "running", "terminal"]),
    stage: s.optional(s.string()),
    stageStatus: s.optional(s.string()),
    stages: s.array(s.unknown()),
    outcome: s.optional(s.enum(["PASS", "FAIL", "BLOCKED", "ERROR", "CANCELLED"])),
    /** "pending" | the outcome; an indexable copy for filters. */
    outcomeKey: s.string(),
    workloadId: s.optional(s.string()),
    workAuthority: s.optional(s.unknown()),
    attemptNumber: s.optional(s.integer()),
    fencingToken: s.optional(s.integer()),
    cancelRequested: s.boolean(),
    /** Cancel requested and the harness has not yet reported a terminal result for an admitted workload. */
    cancelPending: s.boolean(),
    cancelRequestedAt: s.optional(s.number()),
    cancelRequestedBy: s.optional(s.string()),
    /** Cancelled by the app before any workload existed. */
    cancelledBeforeAdmission: s.optional(s.boolean()),
    rerunOf: s.optional(s.string()),
    requestedAt: s.number(),
    requestedBy: s.string(),
    admittedAt: s.optional(s.number()),
    startedAt: s.optional(s.number()),
    terminalAt: s.optional(s.number()),
    lastSeq: s.integer(),
    eventCount: s.integer({ minimum: 0 }),
    evidenceCount: s.integer({ minimum: 0 }),
    /** Contract RunResult, as the harness reported it. */
    result: s.optional(s.unknown()),
    updatedAt: s.number(),
  },
  { description: "Run projections. Changed only through the harness capabilities (plus launch/cancel/rerun requests)." },
);

/** Events of a run, ordered by seq. Idempotent on (runId, seq). */
export const runEvents = app.collection(
  "runEvents",
  {
    runId: s.string(),
    seq: s.integer({ minimum: 0 }),
    at: s.string(),
    source: s.enum(["agent", "runtime", "pax", "evaluator", "harness"]),
    kind: s.string({ maxLength: 64 }),
    summary: s.string({ maxLength: 2000 }),
    data: s.optional(s.unknown()),
    receivedAt: s.number(),
  },
  { description: "Run events (append-only)." },
);

/** Evidence index with bounded content. Idempotent on (runId, evidenceId). */
export const evidence = app.collection(
  "evidence",
  {
    runId: s.string(),
    evidenceId: s.string({ minLength: 1, maxLength: 120 }),
    kind: s.enum(["pax.observation", "pax.test", "diff", "process", "agent.report", "acceptance", "log", "digest"]),
    label: s.string({ maxLength: 300 }),
    source: s.enum(["agent", "runtime", "pax", "evaluator", "harness"]),
    digest: s.string(),
    content: s.optional(s.string()),
    size: s.optional(s.integer({ minimum: 0 })),
    path: s.optional(s.string({ maxLength: 500 })),
    receivedAt: s.number(),
  },
  { description: "Evidence items of runs (append-only)." },
);

/**
 * The environment's AppPort Services Intelligence selection, as last observed by an
 * admin (`npm run model:sync`). Intelligence stays authoritative; this is a dated copy
 * the Agent Configuration screen can show. Never a secret: only the credential reference.
 */
export const modelObservations = app.collection(
  "modelObservations",
  {
    environment: s.string(),
    ready: s.boolean(),
    source: s.string(),
    provider: s.optional(s.string()),
    model: s.optional(s.string()),
    endpoint: s.optional(s.string()),
    protocol: s.optional(s.string()),
    credentialRef: s.optional(s.string()),
    credentialPresent: s.boolean(),
    problems: s.array(s.string()),
    observedAt: s.number(),
    observedBy: s.string(),
  },
  { description: "Observed AppPort Services Intelligence selections (newest wins)." },
);
