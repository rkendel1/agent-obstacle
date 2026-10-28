import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { definition } from "./support.js";

test("the experiment digest is stable: key order and empty optional fields do not change it", async () => {
  const t = await createTestApp();
  try {
    const grace = t.as("grace");
    const a = await grace.query(api.experiments.preview, definition);
    const shuffled = {
      environment: { kind: "local-isolated" as const },
      obstacles: { enabled: true },
      budgets: { maxOutputTokens: 16384, callTimeoutSecs: 300, deadlineSecs: 1200, maxExecutions: 50, maxTurns: 50 },
      model: { inference: { temperature: 0 }, credentialRef: "credential-ref:local-llm", endpoint: "http://127.0.0.1:8081/v1/chat/completions", model: "qwen2.5-coder-3b", provider: "custom" },
      agent: { options: { recovery: { allowRetry: true }, capabilities: ["shell", "read_file", "write_file"] }, version: "0.1.0", adapter: "stack-agent" as const },
    };
    const b = await grace.query(api.experiments.preview, shuffled);
    assert.equal(a.digest, b.digest);
    const saved = await grace.mutation(api.experiments.save, { name: "Baseline", ...shuffled });
    assert.equal(saved.digest, a.digest);
    // A different budget is a different definition.
    const c = await grace.query(api.experiments.preview, { ...definition, budgets: { ...definition.budgets, maxTurns: 51 } });
    assert.notEqual(c.digest, a.digest);
    // Stable across a restart (nothing in the digest depends on the runtime).
    await t.restart();
    assert.equal((await t.as("grace").query(api.experiments.get, { experimentId: saved.experimentId })).digest, a.digest);
  } finally {
    await t.close();
  }
});

test("editing an experiment creates a new revision; the old revision is unchanged; no-op edits create nothing", async () => {
  const t = await createTestApp();
  try {
    const grace = t.as("grace");
    const r1 = await grace.mutation(api.experiments.save, { name: "Baseline", ...definition });
    const same = await grace.mutation(api.experiments.save, { lineageId: r1.lineageId, name: "Baseline", ...definition });
    assert.equal(same.unchanged, true);
    assert.equal(same.experimentId, r1.experimentId);
    const r2 = await grace.mutation(api.experiments.save, { lineageId: r1.lineageId, name: "Baseline", ...definition, budgets: { ...definition.budgets, deadlineSecs: 600 } });
    assert.equal(r2.revision, 2);
    assert.notEqual(r2.digest, r1.digest);
    const old = await grace.query(api.experiments.get, { experimentId: r1.experimentId });
    assert.equal(old.definition.budgets.deadlineSecs, 1200);
    assert.equal(old.digest, r1.digest);
    const list = await grace.query(api.experiments.list);
    assert.deepEqual(list.map((e) => [e.experimentId, e.revision]), [[r2.experimentId, 2]]);
    assert.equal((await grace.query(api.experiments.revisions, { lineageId: r1.lineageId })).length, 2);
  } finally {
    await t.close();
  }
});

test("secret values are never stored: only credential references", async () => {
  const t = await createTestApp();
  try {
    const grace = t.as("grace");
    await assert.rejects(grace.mutation(api.experiments.save, { name: "x", ...definition, model: { ...definition.model, credentialRef: "sk-abcdefghijklmnopqrstuvwxyz" } }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(
      grace.mutation(api.experiments.save, { name: "x", ...definition, model: { ...definition.model, inference: { apiKey: "hunter2hunter2" } } }),
      (e: any) => e.details.reason === "secret_value",
    );
    await assert.rejects(
      grace.mutation(api.experiments.save, { name: "x", ...definition, agent: { adapter: "stack-agent", options: { flags: { note: "token sk-proj-ABCDEFGHIJKLMNOPQRSTU" } } } }),
      (e: any) => e.details.reason === "secret_value",
    );
    await assert.rejects(t.as("linus").mutation(api.experiments.save, { name: "x", ...definition }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("the environment's Intelligence selection is recorded by an admin, read by everyone, never a secret", async () => {
  const t = await createTestApp();
  try {
    assert.equal(await t.as("linus").query(api.models.environment), null);
    await assert.rejects(
      t.as("grace").mutation(api.models.record, { ready: true, source: "intelligence", provider: "custom", model: "qwen" }),
      { code: "FORBIDDEN" },
    );
    await t.as("ada").mutation(api.models.record, { ready: true, source: "intelligence", provider: "custom", model: "qwen2.5-coder-3b", endpoint: "http://127.0.0.1:8081/v1", credentialRef: "credential-ref:local-llm", credentialPresent: false, problems: [] });
    const seen = await t.as("linus").query(api.models.environment);
    assert.equal(seen!.model, "qwen2.5-coder-3b");
    assert.equal(seen!.credentialRef, "credential-ref:local-llm");
    assert.equal(seen!.environment, "test");
  } finally {
    await t.close();
  }
});
