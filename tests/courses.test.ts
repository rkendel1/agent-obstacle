import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { digestOf } from "../feltkit/lib/canonical.js";
import { sampleCourse, seed } from "./support.js";

test("publishing a course version computes its digest over canonical JSON and is idempotent", async () => {
  const t = await createTestApp();
  try {
    const course = sampleCourse();
    // Same document, keys in a different order: same canonical JSON, same digest.
    const reordered = Object.fromEntries(Object.entries(course).reverse());
    assert.equal(digestOf(course), digestOf(reordered));
    const first = await t.as("ada").mutation(api.courses.publish, { course, digest: digestOf(course) });
    assert.equal(first.created, true);
    assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
    const again = await t.as("ada").mutation(api.courses.publish, { course: reordered });
    assert.deepEqual(again, { ...first, created: false });
    // A supplied digest that does not match is refused; bare hex is accepted.
    await assert.rejects(t.as("ada").mutation(api.courses.publish, { course, digest: "sha256:" + "0".repeat(64) }), { code: "INVALID_ARGUMENT" });
    const bare = await t.as("ada").mutation(api.courses.publish, { course, digest: first.digest.slice(7) });
    assert.equal(bare.created, false);
  } finally {
    await t.close();
  }
});

test("a published course version is immutable; a new version is allowed; results stay attached to their version", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const { courseVersionId, experimentId } = await seed(t);
    const original = await ada.query(api.courses.get, { courseVersionId });
    assert.equal(original.status, "published");

    // Every change path is refused.
    const changed = sampleCourse({ acceptance: { summary: "Easier acceptance", checks: ["visible-tests"] } });
    await assert.rejects(ada.mutation(api.courses.publish, { course: changed }), (e: any) => e.code === "INVALID_ARGUMENT" && e.details.reason === "immutable_version");
    await assert.rejects(ada.mutation(api.courses.updateDraft, { courseVersionId, spec: changed }), (e: any) => e.details.reason === "immutable_version");
    await assert.rejects(ada.mutation(api.courses.publishDraft, { courseVersionId }), (e: any) => e.details.reason === "immutable_version");
    await assert.rejects(ada.mutation(api.courses.discardDraft, { courseVersionId }), (e: any) => e.details.reason === "immutable_version");
    await assert.rejects(ada.mutation(api.courses.createDraft, { spec: changed }), (e: any) => e.details.reason === "immutable_version");

    const { runId } = await t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId });

    // A new version (draft → publish) is allowed and does not touch v1.
    const v2spec = sampleCourse({ version: "1.1.0", acceptance: { summary: "Stricter", checks: ["visible-tests", "hidden-acceptance", "clippy"] } });
    const draft = await t.as("grace").mutation(api.courses.createDraft, { spec: v2spec, derivedFrom: courseVersionId });
    await assert.rejects(t.as("grace").mutation(api.courses.publishDraft, { courseVersionId: draft.courseVersionId }), { code: "FORBIDDEN" });
    await assert.rejects(t.as("grace").mutation(api.runs.launch, { experimentId, courseVersionId: draft.courseVersionId }), (e: any) => e.details.reason === "not_published");
    const v2 = await ada.mutation(api.courses.publishDraft, { courseVersionId: draft.courseVersionId });
    assert.notEqual(v2.digest, original.digest);

    const after = await ada.query(api.courses.get, { courseVersionId });
    assert.deepEqual(after.spec, original.spec);
    assert.equal(after.digest, original.digest);
    assert.equal(after.attempts, 1);
    const run = await ada.query(api.runs.get, { runId });
    assert.equal(run.courseVersionId, courseVersionId);
    assert.equal(run.courseDigest, original.digest);

    const [entry] = await ada.query(api.courses.library);
    assert.equal(entry!.latest!.version, "1.1.0");
    assert.equal(entry!.publishedCount, 2);
    assert.equal((await ada.query(api.courses.versions, { courseId: "course-000-calibration" })).length, 2);
  } finally {
    await t.close();
  }
});

test("drafts can be edited and discarded; invalid documents are refused with every problem", async () => {
  const t = await createTestApp();
  try {
    const grace = t.as("grace");
    const draft = await grace.mutation(api.courses.createDraft, { spec: sampleCourse({ version: "0.1.0" }) });
    await grace.mutation(api.courses.updateDraft, { courseVersionId: draft.courseVersionId, spec: sampleCourse({ version: "0.1.0", name: "Calibration (edited)" }) });
    assert.equal((await grace.query(api.courses.get, { courseVersionId: draft.courseVersionId })).name, "Calibration (edited)");
    await grace.mutation(api.courses.discardDraft, { courseVersionId: draft.courseVersionId });
    assert.deepEqual(await grace.query(api.courses.drafts), []);

    const { meta: _meta, ...noMeta } = sampleCourse();
    await assert.rejects(grace.mutation(api.courses.createDraft, { spec: { ...noMeta, identity: { id: "Bad Id", version: "1" } } }), (e: any) => {
      assert.equal(e.details.reason, "invalid_course");
      assert.ok(e.details.problems.some((p: string) => p.includes("meta")));
      assert.ok(e.details.problems.some((p: string) => p.includes("identity.id")));
      return true;
    });
    // Viewers cannot draft; developers cannot publish.
    await assert.rejects(t.as("linus").mutation(api.courses.createDraft, { spec: sampleCourse() }), { code: "FORBIDDEN" });
    await assert.rejects(grace.mutation(api.courses.publish, { course: sampleCourse() }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});
