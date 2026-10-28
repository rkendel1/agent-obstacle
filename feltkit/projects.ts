import { fail, s } from "@feltdb/feltkit";
import { app, projects, tasks } from "./app.js";

const Project = s.object({
  id: s.string(),
  name: s.string(),
  createdAt: s.number(),
  createdBy: s.string(),
  open: s.integer(),
  done: s.integer(),
});

/** Every project with its task counts. */
export const list = app.query({
  access: "projects.read",
  returns: s.array(Project),
  capability: { name: "projects.list", description: "List projects with their open and completed task counts." },
  handler: async (ctx) => {
    const [all, allTasks] = await Promise.all([ctx.db.find(projects, {}, { orderBy: [{ field: "createdAt", direction: "asc" }] }), ctx.db.find(tasks)]);
    return all.map((p) => {
      const mine = allTasks.filter((t) => t.projectId === p.id);
      return { id: p.id, name: p.name, createdAt: p.createdAt, createdBy: p.createdBy, open: mine.filter((t) => !t.done).length, done: mine.filter((t) => t.done).length };
    });
  },
});

export const create = app.mutation({
  access: "projects.write",
  args: { name: s.string({ minLength: 1, maxLength: 80 }) },
  returns: s.string(),
  handler: async (ctx, { name }) => {
    const trimmed = name.trim();
    if (!trimmed) fail("INVALID_ARGUMENT", "A project needs a name.");
    const existing = await ctx.db.find(projects, { name: trimmed });
    if (existing.length) fail("CONFLICT", `There is already a project called "${trimmed}".`);
    return ctx.db.insert(projects, { name: trimmed, createdAt: Date.now(), createdBy: ctx.auth.requirePrincipal().id });
  },
});

export const rename = app.mutation({
  access: "projects.write",
  args: { id: s.string(), name: s.string({ minLength: 1, maxLength: 80 }) },
  handler: async (ctx, { id, name }) => {
    await ctx.db.patch(projects, id, { name: name.trim() });
  },
});

/** Deletes a project and all of its tasks in one atomic commit. */
export const remove = app.mutation({
  access: "projects.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    for (const task of await ctx.db.find(tasks, { projectId: id })) await ctx.db.delete(tasks, task.id);
    await ctx.db.delete(projects, id);
  },
});
