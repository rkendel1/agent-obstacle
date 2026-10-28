/**
 * Course library and builder.
 *
 * Immutability: a course version whose status is "published" is never patched,
 * replaced, or deleted by any function in this app. Drafts may be edited or discarded;
 * publishing turns a draft into an immutable version. Runs can only be launched against
 * published versions, so acceptance cannot change after an attempt started.
 *
 * Release gate: a version is published only with a passing preflight report (aoc.preflight.v1,
 * docs/courses/acceptance-v1.md) recorded for its exact digest, evaluator and acceptance. The
 * report that gated the publish is bound to the version and can never be replaced.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { app, courses, courseVersions, preflightReports, runs } from "./app.js";
import { digestOf, normalizeDigest } from "./lib/canonical.js";
import { displayOf, validateCourse, type CourseSummary } from "./lib/course.js";
import { preflightMismatches, REQUIRED_GATES, validatePreflightReport } from "./lib/preflight.js";

function summaryOf(v: Record<string, any>) {
  return {
    courseVersionId: v.id as string,
    courseId: v.courseId as string,
    version: v.version as string,
    ref: v.ref as string,
    status: v.status as "draft" | "published",
    digest: v.digest as string,
    name: v.name as string,
    description: v.description as string,
    kind: v.kind as "deterministic" | "randomized" | "adversarial",
    difficulty: v.difficulty as string,
    skills: v.skills as string[],
    expectedRuntimeSecs: (v.expectedRuntimeSecs ?? null) as number | null,
    derivedFrom: (v.derivedFrom ?? null) as string | null,
    createdAt: v.createdAt as number,
    createdBy: v.createdBy as string,
    publishedAt: (v.publishedAt ?? null) as number | null,
    publishedBy: (v.publishedBy ?? null) as string | null,
    acceptanceDigest: (v.acceptanceDigest ?? acceptanceDigestOf(v.spec)) as string | null,
    evaluatorKind: (v.evaluatorKind ?? (v.spec as any)?.evaluator?.kind ?? null) as string | null,
    preflightId: (v.preflightId ?? null) as string | null,
    preflightReportDigest: (v.preflightReportDigest ?? null) as string | null,
    display: displayOf(v.spec),
  };
}

function acceptanceDigestOf(spec: unknown): string | null {
  const acc = (spec as any)?.acceptance;
  return acc === undefined ? null : digestOf(acc);
}

function preflightView(p: Record<string, any>) {
  return {
    preflightId: p.id as string,
    courseDigest: p.courseDigest as string,
    reportDigest: p.reportDigest as string,
    result: p.result as "pass" | "fail",
    passing: p.passing as boolean,
    evaluatorKind: p.evaluatorKind as string,
    evaluatorVersion: (p.evaluatorVersion ?? null) as string | null,
    evaluatorDigest: (p.evaluatorDigest ?? null) as string | null,
    acceptanceDigest: (p.acceptanceDigest ?? null) as string | null,
    gates: p.gates as { id: string; result: string }[],
    completedAt: p.completedAt as string,
    recordedAt: p.recordedAt as number,
    recordedBy: p.recordedBy as string,
  };
}

/** Record a preflight report (append-only; idempotent on its digest). Refused once its course digest is published. */
async function recordReport(ctx: MutationCtx, report: unknown, who: string, now: number) {
  const summary = validatePreflightReport(report);
  const [same] = await ctx.db.find(preflightReports, { reportDigest: summary.reportDigest }, { limit: 1 });
  if (same) return { preflightId: same.id as string, summary, created: false };
  const [published] = await ctx.db.find(courseVersions, { digest: summary.courseDigest, status: "published" }, { limit: 1 });
  if (published) {
    fail("INVALID_ARGUMENT", `${published.ref} is already published (gated by preflight ${published.preflightReportDigest ?? "of an earlier release"}); its preflight record is frozen.`, {
      reason: "immutable_version",
      ref: published.ref,
    });
  }
  const id = await ctx.db.insert(preflightReports, {
    ref: `${summary.courseId}@${summary.version}`,
    courseId: summary.courseId,
    version: summary.version,
    courseDigest: summary.courseDigest,
    reportDigest: summary.reportDigest,
    result: summary.result,
    passing: summary.passing,
    evaluatorKind: summary.evaluatorKind,
    ...(summary.evaluatorVersion ? { evaluatorVersion: summary.evaluatorVersion } : {}),
    ...(summary.evaluatorDigest ? { evaluatorDigest: summary.evaluatorDigest } : {}),
    ...(summary.acceptanceDigest ? { acceptanceDigest: summary.acceptanceDigest } : {}),
    gates: summary.gates,
    completedAt: summary.completedAt,
    report,
    recordedAt: now,
    recordedBy: who,
  });
  return { preflightId: id, summary, created: true };
}

/** The passing preflight report that vouches for exactly this document, or a refusal. */
async function requirePreflight(ctx: MutationCtx, spec: unknown, digest: string) {
  const list = await ctx.db.find(preflightReports, { courseDigest: digest }, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: 20 });
  const passing = list.filter((p) => p.passing);
  if (!passing.length) {
    const latest = list[0];
    const failed = latest ? [...latest.gates.filter((g) => g.result !== "pass").map((g) => `${g.id} ${g.result}`), ...REQUIRED_GATES.filter((id) => !latest.gates.some((g) => g.id === id)).map((id) => `${id} missing`)].join(", ") || `result ${latest.result}` : "";
    fail(
      "INVALID_ARGUMENT",
      list.length
        ? `No passing preflight for ${digest}: the recorded report failed (${failed}). Fix the course and run npm run courses:preflight again.`
        : `No preflight report for ${digest}. A course version is published only after a passing preflight: npm run courses:preflight -- <course>/<version>, then publish with it.`,
      { reason: list.length ? "preflight_failed" : "preflight_required", courseDigest: digest },
    );
  }
  let problems: string[] = [];
  for (const p of passing) {
    problems = preflightMismatches(
      { courseId: p.courseId, version: p.version, courseDigest: p.courseDigest, evaluatorKind: p.evaluatorKind, evaluatorDigest: p.evaluatorDigest ?? null, acceptanceDigest: p.acceptanceDigest ?? null },
      spec,
    );
    if (!problems.length) return p;
  }
  fail("INVALID_ARGUMENT", `The preflight report does not match this course document: ${problems.join("; ")}.`, { reason: "preflight_mismatch", problems });
}

/** Refuse any change to a published version. Every write path calls this first. */
export function assertDraft(version: Record<string, any>): void {
  if (version.status !== "draft") {
    fail("INVALID_ARGUMENT", `${version.ref} is published and immutable. Create a new version instead.`, { reason: "immutable_version", ref: version.ref });
  }
}

async function versionByRef(ctx: QueryCtx | MutationCtx, ref: string) {
  const [found] = await ctx.db.find(courseVersions, { ref }, { limit: 1 });
  return found ?? null;
}

async function ensureCourse(ctx: MutationCtx, summary: CourseSummary, who: string, now: number) {
  const [course] = await ctx.db.find(courses, { courseId: summary.courseId }, { limit: 1 });
  if (course) return course;
  const id = await ctx.db.insert(courses, {
    courseId: summary.courseId,
    name: summary.name,
    description: summary.description,
    publishedCount: 0,
    createdAt: now,
    createdBy: who,
    updatedAt: now,
  });
  return (await ctx.db.get(courses, id))!;
}

function versionFields(spec: unknown, summary: CourseSummary) {
  return {
    courseId: summary.courseId,
    version: summary.version,
    ref: `${summary.courseId}@${summary.version}`,
    digest: digestOf(spec),
    spec,
    name: summary.name,
    description: summary.description,
    kind: summary.kind,
    difficulty: summary.difficulty,
    skills: summary.skills,
    ...(summary.expectedRuntimeSecs !== undefined ? { expectedRuntimeSecs: summary.expectedRuntimeSecs } : {}),
    acceptanceDigest: digestOf((spec as Record<string, unknown>).acceptance),
    evaluatorKind: String(((spec as Record<string, any>).evaluator ?? {}).kind ?? ""),
  };
}

/** Publish a draft record (status draft → published). The only transition a version makes; it needs a passing preflight for the exact document. */
async function publishVersion(ctx: MutationCtx, version: Record<string, any>, who: string, now: number) {
  assertDraft(version);
  const preflight = await requirePreflight(ctx, version.spec, version.digest);
  await ctx.db.patch(courseVersions, version.id, { status: "published", publishedAt: now, publishedBy: who, preflightId: preflight.id, preflightReportDigest: preflight.reportDigest, updatedAt: now });
  const [course] = await ctx.db.find(courses, { courseId: version.courseId }, { limit: 1 });
  if (course) {
    await ctx.db.patch(courses, course.id, {
      name: version.name,
      description: version.description,
      latestPublishedVersionId: version.id,
      latestPublishedVersion: version.version,
      publishedCount: course.publishedCount + 1,
      updatedAt: now,
    });
  }
}

/**
 * Publish a course version from a course.json document. Idempotent: publishing the same
 * document again returns the existing version (created: false). A different document under
 * an already published id@version is refused: versions are immutable. A new version needs a
 * passing preflight report for its exact digest: sent here as `preflight` (recorded first), or
 * recorded earlier with courses.preflight.record.
 */
export const publish = app.mutation({
  access: "courses.publish",
  args: { course: s.unknown(), digest: s.optional(s.string({ maxLength: 80 })), preflight: s.optional(s.unknown()) },
  returns: s.object({ courseVersionId: s.string(), ref: s.string(), digest: s.string(), created: s.boolean() }),
  capability: {
    name: "courses.publish",
    description:
      "Publish an immutable course version from a course.json document. The digest is sha256 over canonical JSON; a supplied digest must match. Needs a passing preflight report (aoc.preflight.v1) for exactly this document.",
  },
  handler: async (ctx, { course, digest, preflight }) => {
    const who = ctx.auth.requirePrincipal().id;
    const summary = validateCourse(course);
    const computed = digestOf(course);
    if (digest !== undefined) {
      const supplied = normalizeDigest(digest);
      if (!supplied) fail("INVALID_ARGUMENT", "digest must be sha256:<64 hex> (or 64 hex characters).", { reason: "invalid_digest" });
      if (supplied !== computed) fail("INVALID_ARGUMENT", `Digest mismatch: supplied ${supplied}, computed ${computed} over canonical JSON.`, { reason: "digest_mismatch", computed });
    }
    const ref = `${summary.courseId}@${summary.version}`;
    const now = Date.now();
    const existing = await versionByRef(ctx, ref);
    if (existing?.status === "published") {
      if (existing.digest === computed) return { courseVersionId: existing.id, ref, digest: computed, created: false };
      fail("INVALID_ARGUMENT", `${ref} is already published with digest ${existing.digest}; published versions are immutable. Publish a new version.`, {
        reason: "immutable_version",
        existingDigest: existing.digest,
      });
    }
    if (preflight !== undefined) await recordReport(ctx, preflight, who, now);
    await requirePreflight(ctx, course, computed);
    await ensureCourse(ctx, summary, who, now);
    let id: string;
    if (existing) {
      assertDraft(existing);
      await ctx.db.patch(courseVersions, existing.id, { ...versionFields(course, summary), updatedAt: now });
      id = existing.id;
    } else {
      id = await ctx.db.insert(courseVersions, { ...versionFields(course, summary), status: "draft", createdAt: now, createdBy: who, updatedAt: now });
    }
    await publishVersion(ctx, (await ctx.db.get(courseVersions, id))!, who, now);
    return { courseVersionId: id, ref, digest: computed, created: true };
  },
});

/**
 * Record a preflight report (admin). Append-only and idempotent on the report's digest; a
 * failing report is recorded too (it never gates a publish). Refused for a course digest that
 * is already published: the report that gated a release is frozen with it.
 */
export const recordPreflight = app.mutation({
  access: "courses.publish",
  args: { report: s.unknown() },
  returns: s.object({ preflightId: s.string(), courseDigest: s.string(), reportDigest: s.string(), passing: s.boolean(), created: s.boolean() }),
  capability: {
    name: "courses.preflight.record",
    description: "Record a course preflight report (aoc.preflight.v1). Append-only; refused once the course digest is published.",
  },
  handler: async (ctx, { report }) => {
    const who = ctx.auth.requirePrincipal().id;
    const out = await recordReport(ctx, report, who, Date.now());
    return { preflightId: out.preflightId, courseDigest: out.summary.courseDigest, reportDigest: out.summary.reportDigest, passing: out.summary.passing, created: out.created };
  },
});

/** Preflight reports recorded for one course digest, newest first. */
export const preflights = app.query({
  access: "courses.read",
  args: { courseDigest: s.string() },
  handler: async (ctx, { courseDigest }) => {
    const digest = normalizeDigest(courseDigest);
    if (!digest) return [];
    const list = await ctx.db.find(preflightReports, { courseDigest: digest }, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: 50 });
    return list.map(preflightView);
  },
});

/** Course Library: every course with its latest published version (bounded). */
export const library = app.query({
  access: "courses.read",
  handler: async (ctx) => {
    const list = await ctx.db.find(courses, {}, { orderBy: [{ field: "name", direction: "asc" }], limit: 200 });
    const out = [];
    for (const course of list) {
      const latest = course.latestPublishedVersionId ? await ctx.db.get(courseVersions, course.latestPublishedVersionId) : null;
      out.push({
        id: course.id,
        courseId: course.courseId,
        name: course.name,
        description: course.description,
        publishedCount: course.publishedCount,
        latest: latest ? summaryOf(latest) : null,
      });
    }
    return out;
  },
});

/** Every version of one course (newest first), without the full spec. */
export const versions = app.query({
  access: "courses.read",
  args: { courseId: s.string() },
  handler: async (ctx, { courseId }) => {
    const list = await ctx.db.find(courseVersions, { courseId }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 100 });
    return list.map(summaryOf);
  },
});

/** Published versions (for pickers), newest first. */
export const published = app.query({
  access: "courses.read",
  handler: async (ctx) => {
    const list = await ctx.db.find(courseVersions, { status: "published" }, { orderBy: [{ field: "publishedAt", direction: "desc" }], limit: 300 });
    return list.map((v) => ({ courseVersionId: v.id, ref: v.ref, name: v.name, version: v.version, courseId: v.courseId, digest: v.digest }));
  },
});

/** Drafts, newest first. */
export const drafts = app.query({
  access: "courses.read",
  handler: async (ctx) => {
    const list = await ctx.db.find(courseVersions, { status: "draft" }, { orderBy: [{ field: "updatedAt", direction: "desc" }], limit: 100 });
    return list.map(summaryOf);
  },
});

/** One version with its full spec (Inspect spec, Builder). */
export const get = app.query({
  access: "courses.read",
  args: { courseVersionId: s.string() },
  handler: async (ctx, { courseVersionId }) => {
    const v = await ctx.db.get(courseVersions, courseVersionId);
    if (!v) fail("NOT_FOUND", "No such course version.");
    const attempts = await ctx.db.count(runs, { courseVersionId });
    const gate = v.preflightId ? await ctx.db.get(preflightReports, v.preflightId) : null;
    const [latest] = gate ? [] : await ctx.db.find(preflightReports, { courseDigest: v.digest }, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: 1 });
    const pf = gate ?? latest ?? null;
    return { ...summaryOf(v), spec: v.spec, attempts, preflight: pf ? preflightView(pf) : null };
  },
});

/** Course Builder: create a draft version from a document. */
export const createDraft = app.mutation({
  access: "courses.draft",
  args: { spec: s.unknown(), derivedFrom: s.optional(s.string()) },
  handler: async (ctx, { spec, derivedFrom }) => {
    const who = ctx.auth.requirePrincipal().id;
    const summary = validateCourse(spec);
    const ref = `${summary.courseId}@${summary.version}`;
    const existing = await versionByRef(ctx, ref);
    if (existing) {
      fail("INVALID_ARGUMENT", existing.status === "published" ? `${ref} is already published. Choose a new version.` : `A draft ${ref} already exists. Edit it instead.`, {
        reason: existing.status === "published" ? "immutable_version" : "draft_exists",
        courseVersionId: existing.id,
      });
    }
    const now = Date.now();
    await ensureCourse(ctx, summary, who, now);
    const id = await ctx.db.insert(courseVersions, {
      ...versionFields(spec, summary),
      status: "draft",
      ...(derivedFrom ? { derivedFrom } : {}),
      createdAt: now,
      createdBy: who,
      updatedAt: now,
    });
    return { courseVersionId: id, ref };
  },
});

/** Course Builder: replace a draft's document. Refused for published versions. */
export const updateDraft = app.mutation({
  access: "courses.draft",
  args: { courseVersionId: s.string(), spec: s.unknown() },
  handler: async (ctx, { courseVersionId, spec }) => {
    const who = ctx.auth.requirePrincipal().id;
    const v = await ctx.db.get(courseVersions, courseVersionId);
    if (!v) fail("NOT_FOUND", "No such course version.");
    assertDraft(v);
    const summary = validateCourse(spec);
    const ref = `${summary.courseId}@${summary.version}`;
    if (ref !== v.ref) {
      const clash = await versionByRef(ctx, ref);
      if (clash) fail("INVALID_ARGUMENT", `${ref} already exists.`, { reason: clash.status === "published" ? "immutable_version" : "draft_exists" });
    }
    const now = Date.now();
    await ensureCourse(ctx, summary, who, now);
    await ctx.db.patch(courseVersions, courseVersionId, { ...versionFields(spec, summary), updatedAt: now });
    return { courseVersionId, ref };
  },
});

/** Discard a draft. Refused for published versions. */
export const discardDraft = app.mutation({
  access: "courses.draft",
  args: { courseVersionId: s.string() },
  handler: async (ctx, { courseVersionId }) => {
    const v = await ctx.db.get(courseVersions, courseVersionId);
    if (!v) fail("NOT_FOUND", "No such course version.");
    assertDraft(v);
    await ctx.db.delete(courseVersions, courseVersionId);
  },
});

/** Publish a draft (admin). After this the version never changes. */
export const publishDraft = app.mutation({
  access: "courses.publish",
  args: { courseVersionId: s.string(), digest: s.optional(s.string()) },
  handler: async (ctx, { courseVersionId, digest }) => {
    const who = ctx.auth.requirePrincipal().id;
    const v = await ctx.db.get(courseVersions, courseVersionId);
    if (!v) fail("NOT_FOUND", "No such course version.");
    assertDraft(v);
    if (digest !== undefined && normalizeDigest(digest) !== v.digest) {
      fail("INVALID_ARGUMENT", "The draft changed since you reviewed it (digest mismatch). Review it again.", { reason: "digest_mismatch", digest: v.digest });
    }
    await publishVersion(ctx, v, who, Date.now());
    return { courseVersionId, ref: v.ref, digest: v.digest };
  },
});
