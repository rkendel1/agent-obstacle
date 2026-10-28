/**
 * Agent Configuration: saved, reproducible experiment definitions.
 *
 * Each record is one immutable revision (its definition, digest and name never change).
 * Editing creates a new revision in the same lineage; only the `latest` marker moves.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, courseVersions, experiments } from "./app.js";
import { definitionDigest, assertNoSecrets, modelLabel, normalizeDefinition, type Definition } from "./lib/experiment.js";
import { DefinitionShape } from "./lib/schemas.js";
import { newLineageId } from "./lib/ids.js";

function view(e: Record<string, any>) {
  return {
    experimentId: e.id as string,
    lineageId: e.lineageId as string,
    revision: e.revision as number,
    latest: e.latest as boolean,
    name: e.name as string,
    notes: (e.notes ?? "") as string,
    digest: e.digest as string,
    definition: e.definition as Definition,
    adapter: e.adapter as string,
    modelLabel: e.modelLabel as string,
    defaultCourseVersionId: (e.defaultCourseVersionId ?? null) as string | null,
    createdAt: e.createdAt as number,
    createdBy: e.createdBy as string,
  };
}

/** Compute the digest of a definition without saving it (shown live in the form). */
export const preview = app.query({
  access: "experiments.read",
  args: DefinitionShape,
  handler: (_ctx, input) => {
    const definition = normalizeDefinition(input as Definition);
    return { digest: definitionDigest(definition), definition };
  },
});

/**
 * Save an experiment. Without lineageId: a new experiment (revision 1). With lineageId: a
 * new revision, unless nothing changed (then the current revision is returned).
 */
export const save = app.mutation({
  access: "experiments.write",
  args: {
    lineageId: s.optional(s.string()),
    name: s.string({ minLength: 1, maxLength: 120 }),
    notes: s.optional(s.string({ maxLength: 4000 })),
    defaultCourseVersionId: s.optional(s.string()),
    ...DefinitionShape,
  },
  handler: async (ctx, { lineageId, name, notes, defaultCourseVersionId, ...input }) => {
    const who = ctx.auth.requirePrincipal().id;
    const definition = normalizeDefinition(input as Definition);
    assertNoSecrets(definition);
    assertNoSecrets(notes ?? "", "notes");
    const digest = definitionDigest(definition);
    if (defaultCourseVersionId) {
      const v = await ctx.db.get(courseVersions, defaultCourseVersionId);
      if (!v) fail("NOT_FOUND", "The default course version does not exist.");
    }
    let revision = 1;
    let lineage = lineageId;
    if (lineageId) {
      const [current] = await ctx.db.find(experiments, { lineageId, latest: true }, { limit: 1 });
      if (!current) fail("NOT_FOUND", "No such experiment.");
      if (current.digest === digest && current.name === name.trim() && (current.notes ?? "") === (notes ?? "").trim() && (current.defaultCourseVersionId ?? undefined) === (defaultCourseVersionId || undefined)) {
        return { experimentId: current.id, lineageId, revision: current.revision, digest, unchanged: true };
      }
      revision = current.revision + 1;
      await ctx.db.patch(experiments, current.id, { latest: false });
    } else {
      lineage = newLineageId();
    }
    const id = await ctx.db.insert(experiments, {
      lineageId: lineage!,
      revision,
      latest: true,
      name: name.trim(),
      ...(notes?.trim() ? { notes: notes.trim() } : {}),
      digest,
      definition,
      adapter: definition.agent.adapter,
      modelLabel: modelLabel(definition),
      ...(defaultCourseVersionId ? { defaultCourseVersionId } : {}),
      createdAt: Date.now(),
      createdBy: who,
    });
    return { experimentId: id, lineageId: lineage!, revision, digest, unchanged: false };
  },
});

/** The latest revision of every experiment, newest first. */
export const list = app.query({
  access: "experiments.read",
  handler: async (ctx) => {
    const latest = await ctx.db.find(experiments, { latest: true }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 200 });
    return latest.map(view);
  },
});

export const get = app.query({
  access: "experiments.read",
  args: { experimentId: s.string() },
  handler: async (ctx, { experimentId }) => {
    const e = await ctx.db.get(experiments, experimentId);
    if (!e) fail("NOT_FOUND", "No such experiment.");
    return view(e);
  },
});

/** Every revision of one experiment, newest first. */
export const revisions = app.query({
  access: "experiments.read",
  args: { lineageId: s.string() },
  handler: async (ctx, { lineageId }) => {
    const list = await ctx.db.find(experiments, { lineageId }, { orderBy: [{ field: "revision", direction: "desc" }], limit: 100 });
    return list.map(view);
  },
});
