/**
 * The application: its name, who may do what, and its data.
 *
 * Everything here is stored in one FeltDB instance per environment. In development
 * that is .feltkit/development/state — run `npx feltkit inspect` to see it.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "agent-obstacle-course",
  description: "A small task manager that demonstrates the whole FeltKit platform.",
  // Roles grant AppPort permissions. "tasks.*" grants every tasks.<x> permission.
  roles: {
    member: ["projects.*", "tasks.*", "files.*"],
    viewer: ["projects.read", "tasks.read", "files.read"],
    // Agents can read, complete tasks, and leave notes. They cannot create or delete.
    agent: ["projects.read", "tasks.read", "tasks.complete", "tasks.note", "files.read", "files.write"],
  },
  // Development-only identities. Sign in as them from the app or the dashboard.
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member"] },
      { id: "grace", name: "Grace Hopper", roles: ["viewer"] },
    ],
  },
  // AppPort Services: Files, stored in this app's FeltDB instance.
  services: { files: true },
});

export const projects = app.collection("projects", {
  name: s.string({ minLength: 1, maxLength: 80 }),
  createdAt: s.number(),
  createdBy: s.string(),
});

export const tasks = app.collection("tasks", {
  projectId: s.string(),
  title: s.string({ minLength: 1, maxLength: 200 }),
  details: s.optional(s.string({ maxLength: 4000 })),
  done: s.boolean(),
  createdAt: s.number(),
  createdBy: s.string(),
  completedAt: s.optional(s.number()),
  completedBy: s.optional(s.string()),
});
