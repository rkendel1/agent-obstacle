/**
 * Run with `npm test` (`feltkit test`). Each test app gets its own FeltDB instance
 * in a temporary directory — real storage, nothing shared with development.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

test("members manage projects and tasks", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const projectId = await ada.mutation(api.projects.create, { name: "Launch" });
    const taskId = await ada.mutation(api.tasks.create, { projectId, title: "Write the README" });
    await ada.mutation(api.tasks.update, { id: taskId, details: "Cover the first five minutes." });
    await ada.mutation(api.tasks.setDone, { id: taskId, done: true });

    const [task] = await ada.query(api.tasks.list, { projectId });
    assert.equal(task!.title, "Write the README");
    assert.equal(task!.details, "Cover the first five minutes.");
    assert.equal(task!.done, true);
    assert.equal(task!.completedBy, "ada");

    const [project] = await ada.query(api.projects.list);
    assert.deepEqual({ open: project!.open, done: project!.done }, { open: 0, done: 1 });
  } finally {
    await t.close();
  }
});

test("viewers can read but not write; anonymous callers can do neither", async () => {
  const t = await createTestApp();
  try {
    const projectId = await t.as("ada").mutation(api.projects.create, { name: "Docs" });
    const grace = t.as("grace");
    assert.equal((await grace.query(api.projects.list)).length, 1);
    await assert.rejects(grace.mutation(api.tasks.create, { projectId, title: "nope" }), { code: "FORBIDDEN" });
    await assert.rejects(t.query(api.projects.list), { code: "UNAUTHORIZED" });
  } finally {
    await t.close();
  }
});

test("notes are stored by the Files service and readable by viewers", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const projectId = await ada.mutation(api.projects.create, { name: "Research" });
    const taskId = await ada.mutation(api.tasks.create, { projectId, title: "Read the paper" });
    await ada.mutation(api.tasks.addNote, { taskId, text: "Section 3 is the important one." });
    const notes = await t.as("grace").query(api.tasks.notes, { taskId });
    assert.deepEqual(notes.map((n) => [n.author, n.text]), [["ada", "Section 3 is the important one."]]);
    await assert.rejects(t.as("grace").mutation(api.tasks.addNote, { taskId, text: "x" }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("deleting a project removes its tasks in one atomic commit", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const projectId = await ada.mutation(api.projects.create, { name: "Temporary" });
    await ada.mutation(api.tasks.create, { projectId, title: "a" });
    await ada.mutation(api.tasks.create, { projectId, title: "b" });
    await ada.mutation(api.projects.remove, { id: projectId });
    assert.deepEqual(await ada.query(api.projects.list), []);
    assert.deepEqual(await ada.query(api.tasks.list, { projectId }), []);
    const entry = (await t.runtime.activity.list({ name: "projects:remove" }))[0]!;
    assert.deepEqual(entry.writes!.map((w) => w.op).sort(), ["delete", "delete", "delete"]);
  } finally {
    await t.close();
  }
});

test("an agent can complete tasks and leave notes, but not create them", async () => {
  const t = await createTestApp();
  try {
    const projectId = await t.as("ada").mutation(api.projects.create, { name: "Ops" });
    const taskId = await t.as("ada").mutation(api.tasks.create, { projectId, title: "Rotate keys" });
    const agent = t.as({ id: "ops-bot", type: "agent", roles: ["agent"] });
    await agent.mutation(api.tasks.setDone, { id: taskId, done: true });
    await agent.mutation(api.tasks.addNote, { taskId, text: "Rotated." });
    await assert.rejects(agent.mutation(api.tasks.create, { projectId, title: "x" }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("state survives a restart", async () => {
  const t = await createTestApp();
  try {
    const projectId = await t.as("ada").mutation(api.projects.create, { name: "Durable" });
    await t.restart();
    const [project] = await t.as("ada").query(api.projects.list);
    assert.equal(project!.id, projectId);
  } finally {
    await t.close();
  }
});
