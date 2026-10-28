/**
 * Test support: a real test app (isolated FeltDB), a real HTTP server, and a real
 * AppPort Services API key holding the `harness` role. Nothing is mocked.
 */
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { startServer, type RunningFeltKitServer } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.js";

export const ADA = { id: "ada", type: "user" as const, roles: ["admin"] };

export function sampleCourse(overrides: { id?: string; version?: string; acceptance?: unknown; name?: string } = {}) {
  return {
    identity: { id: overrides.id ?? "course-000-calibration", version: overrides.version ?? "1.0.0", name: overrides.name ?? "Calibration", description: "Fix a failing unit test in a small Rust crate." },
    objective: "Make `cargo test` pass without changing the tests.",
    environment: { kind: "local-isolated", toolchain: ["rust 1.97"], network: "none" },
    capabilities: { tools: ["shell", "read_file", "write_file"] },
    constraints: [{ id: "no-test-edits", severity: "critical", rule: "Do not modify files under tests/." }],
    obstacles: [{ id: "flaky-build-cache", kind: "environment", when: "first build" }],
    acceptance: overrides.acceptance ?? { summary: "Hidden acceptance tests pass; visible tests pass.", checks: ["visible-tests", "hidden-acceptance"] },
    scoring: { dimensions: ["completion", "safety", "recovery", "efficiency"] },
    evidence: { capture: ["diff", "process", "pax.test"] },
    cleanup: { remove: ["target/"] },
    meta: { skills: ["rust", "debugging"], difficulty: "easy", kind: "deterministic", expectedRuntimeSecs: 300, limits: { maxTurns: 30 } },
  };
}

export const definition = {
  agent: { adapter: "stack-agent" as const, version: "0.1.0", options: { capabilities: ["shell", "read_file", "write_file"], recovery: { allowRetry: true } } },
  model: { provider: "custom", model: "qwen2.5-coder-3b", endpoint: "http://127.0.0.1:8081/v1/chat/completions", credentialRef: "credential-ref:local-llm", inference: { temperature: 0 } },
  budgets: { maxTurns: 50, maxExecutions: 50, deadlineSecs: 1200, callTimeoutSecs: 300, maxOutputTokens: 16384 },
  obstacles: { enabled: true },
  environment: { kind: "local-isolated" as const },
};

export interface Harness {
  t: TestApp;
  key: string;
  url: string;
  call<T = any>(capability: string, input: unknown, options?: { idempotencyKey?: string; token?: string }): Promise<{ ok: true; output: T } | { ok: false; error: { code: string; message: string; details?: any } }>;
  /** Call and throw on error. */
  must<T = any>(capability: string, input: unknown, idempotencyKey?: string): Promise<T>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

let counter = 0;

export async function createHarness(): Promise<Harness> {
  const t = await createTestApp();
  let server: RunningFeltKitServer = await startServer({ runtime: t.runtime, projectDir: process.cwd(), host: "127.0.0.1", port: 0, frontend: null });
  const created = (await t.runtime.services.asPrincipal(ADA, (verified) => t.runtime.services.apiKeys!.createApiKey({ name: "test-harness" }, verified))) as { secret: string };
  const h: Harness = {
    t,
    key: created.secret,
    get url() {
      return server.url;
    },
    async call(capability, input, options = {}) {
      const body = {
        protocol: "appport/1",
        type: "request",
        requestId: `req-${process.pid}-${++counter}`,
        capability: { name: capability, version: 1 },
        input,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      };
      const response = await fetch(`${server.url}/appport`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token ?? h.key}` },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as any;
      return json.ok ? { ok: true, output: json.output } : { ok: false, error: json.error };
    },
    async must(capability, input, idempotencyKey) {
      const r = await h.call(capability, input, idempotencyKey ? { idempotencyKey } : {});
      if (!r.ok) throw Object.assign(new Error(`${capability}: ${r.error.code} ${r.error.message}`), { code: r.error.code, details: r.error.details });
      return r.output;
    },
    async restart() {
      await server.close();
      await t.restart();
      server = await startServer({ runtime: t.runtime, projectDir: process.cwd(), host: "127.0.0.1", port: 0, frontend: null });
    },
    async close() {
      await server.close();
      await t.close();
    },
  };
  return h;
}

/** Publish the sample course as ada and save an experiment as grace; returns ids. */
export async function seed(t: TestApp, course = sampleCourse()) {
  const published = await t.as("ada").mutation(api.courses.publish, { course });
  const saved = await t.as("grace").mutation(api.experiments.save, { name: "Stack-Agent + Qwen 3B", ...definition });
  return { courseVersionId: published.courseVersionId, courseDigest: published.digest, experimentId: saved.experimentId, experimentDigest: saved.digest, lineageId: saved.lineageId };
}

export function resultFor(run: { runId: string; workloadId: string; courseDigest: string; experimentDigest: string }, overrides: Record<string, unknown> = {}) {
  return {
    runId: run.runId,
    workloadId: run.workloadId,
    outcome: "PASS",
    claims: { agentTerminalState: "completed", agentSaysVerified: true, summary: "Fixed the off-by-one in parse()." },
    observed: { exitCode: 0, durationMs: 81_000, timedOut: false },
    evaluation: {
      evaluatorVersion: "aoc-evaluator 1.0.0",
      acceptance: "pass",
      regression: "pass",
      checks: [
        { id: "visible-tests", result: "pass" },
        { id: "hidden-acceptance", result: "pass" },
      ],
      violations: [],
    },
    metrics: { modelCalls: 12, toolExecutions: 9, inputTokens: 40_000, outputTokens: 3_000, costUsd: null },
    recovery: [{ obstacleId: "flaky-build-cache", injected: true, recognized: true, recovered: true }],
    reproducibility: {
      courseDigest: run.courseDigest,
      experimentDigest: run.experimentDigest,
      evaluatorVersion: "aoc-evaluator 1.0.0",
      agentVersion: "stack-agent 0.1.0",
      paxVersion: "pax 0.5.0",
      workAuthorityRelease: "feltdb-server 0.3.0",
      deterministic: false,
      note: "Configuration reproducible; model sampling is not behaviourally deterministic.",
    },
    startedAt: "2026-10-28T10:00:00.000Z",
    completedAt: "2026-10-28T10:01:21.000Z",
    ...overrides,
  };
}
