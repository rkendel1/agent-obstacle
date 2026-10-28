import { fail, s } from "@feltdb/feltkit";
import { app, projects, tasks } from "./app.js";

const Task = s.object({
  id: s.string(),
  projectId: s.string(),
  title: s.string(),
  details: s.optional(s.string()),
  done: s.boolean(),
  createdAt: s.number(),
  createdBy: s.string(),
  completedAt: s.optional(s.number()),
  completedBy: s.optional(s.string()),
  __version: s.number(),
});

/** Tasks in a project: open first, then completed, oldest first. */
export const list = app.query({
  access: "tasks.read",
  args: { projectId: s.string() },
  returns: s.array(Task),
  capability: { name: "tasks.list", description: "List the tasks in a project, open ones first." },
  handler: async (ctx, { projectId }) => {
    const items = await ctx.db.find(tasks, { projectId }, { orderBy: [{ field: "createdAt", direction: "asc" }] });
    return [...items.filter((t) => !t.done), ...items.filter((t) => t.done)];
  },
});

export const create = app.mutation({
  access: "tasks.write",
  args: { projectId: s.string(), title: s.string({ minLength: 1, maxLength: 200 }), details: s.optional(s.string({ maxLength: 4000 })) },
  returns: s.string(),
  capability: { name: "tasks.create", description: "Add a task to a project." },
  handler: async (ctx, { projectId, title, details }) => {
    if (!(await ctx.db.get(projects, projectId))) fail("NOT_FOUND", "That project does not exist.");
    return ctx.db.insert(tasks, {
      projectId,
      title: title.trim(),
      ...(details?.trim() ? { details: details.trim() } : {}),
      done: false,
      createdAt: Date.now(),
      createdBy: ctx.auth.requirePrincipal().id,
    });
  },
});

export const update = app.mutation({
  access: "tasks.write",
  args: { id: s.string(), title: s.optional(s.string({ minLength: 1, maxLength: 200 })), details: s.optional(s.string({ maxLength: 4000 })) },
  handler: async (ctx, { id, title, details }) => {
    await ctx.db.patch(tasks, id, {
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(details !== undefined ? { details: details.trim() || undefined } : {}),
    });
  },
});

export const setDone = app.mutation({
  access: "tasks.complete",
  args: { id: s.string(), done: s.boolean() },
  returns: s.object({ id: s.string(), done: s.boolean() }),
  capability: { name: "tasks.complete", description: "Mark a task complete (done: true) or reopen it (done: false)." },
  handler: async (ctx, { id, done }) => {
    const who = ctx.auth.requirePrincipal().id;
    const task = await ctx.db.patch(tasks, id, done ? { done: true, completedAt: Date.now(), completedBy: who } : { done: false, completedAt: undefined, completedBy: undefined });
    return { id: task.id, done: task.done };
  },
});

export const remove = app.mutation({
  access: "tasks.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    for (const file of await ctx.services.files.list({ metadata: { taskId: id } })) await ctx.services.files.remove(file.id);
    await ctx.db.delete(tasks, id);
  },
});

/** Notes are text files stored by the AppPort Services Files service in this app's FeltDB instance. */
export const notes = app.query({
  access: "tasks.read",
  args: { taskId: s.string() },
  handler: async (ctx, { taskId }) => {
    const files = await ctx.services.files.list({ metadata: { taskId } });
    return Promise.all(
      files.map(async (file) => ({ id: file.id, author: file.owner, createdAt: file.createdAt, text: (await ctx.services.files.read(file.id)).text() })),
    );
  },
});

export const addNote = app.mutation({
  access: "tasks.note",
  args: { taskId: s.string(), text: s.string({ minLength: 1, maxLength: 8000 }) },
  returns: s.object({ id: s.string() }),
  capability: { name: "tasks.note", description: "Attach a text note to a task (stored with AppPort Services Files)." },
  handler: async (ctx, { taskId, text }) => {
    if (!(await ctx.db.get(tasks, taskId))) fail("NOT_FOUND", "That task does not exist.");
    const file = await ctx.services.files.upload({ name: "note.txt", contentType: "text/plain", content: text.trim(), metadata: { taskId } });
    return { id: file.id };
  },
});
