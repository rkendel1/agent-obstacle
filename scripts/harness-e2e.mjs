#!/usr/bin/env node
/**
 * npm run harness:e2e -- [--app http://127.0.0.1:3000] [--key-file F] [--run course=adapter[:opts]]... [--evidence-dir docs/harness/runs]
 *
 * End-to-end through the REAL app: as the development admin (ada) it saves an experiment
 * (experiments:save) and launches a run (runs:launch) for each --run, then runs the harness
 * (dispatcher + worker, Durable Work on the local feltdb-server) until nothing is pending, and
 * reads the run back from the app (runs:get). Requires: `npm run dev` (FeltKit dev server),
 * `npm run seed:courses`, `npm run harness:authority:setup`, and a harness API key
 * (`npm run harness:key -- --out <file>`), passed as --key-file or AOC_HARNESS_API_KEY.
 *
 *   --run course-000-calibration@v2=reference-control
 *   --run course-000-calibration@v2=stack-agent:model=qwen2.5-coder-3b,endpoint=http://127.0.0.1:8080,obstacles=transient-test-failure
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const APP = (flag("--app") ?? process.env.FELTKIT_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = flag("--key-file") ? readFileSync(flag("--key-file"), "utf8").trim() : process.env.AOC_HARNESS_API_KEY;
const EVDIR = flag("--evidence-dir");
if (!KEY) { console.error("no harness API key (--key-file or AOC_HARNESS_API_KEY)"); process.exit(2); }

async function devToken() {
  const r = await fetch(`${APP}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "ada" }) });
  const b = await r.json(); if (!r.ok) throw new Error(`dev sign-in: ${JSON.stringify(b)}`); return b.token;
}
const token = await devToken();
async function call(kind, name, a = {}) {
  const r = await fetch(`${APP}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ args: a }) });
  const b = await r.json(); if (!b.ok) throw new Error(`${name}: ${JSON.stringify(b.error ?? b)}`); return b.value;
}

const published = await call("query", "courses:published");
const recBudgets = { maxTurns: 12, maxExecutions: 10, deadlineSecs: 900, callTimeoutSecs: 300, maxOutputTokens: 1024 };
const launched = [];
for (const spec of all("--run")) {
  const eq = spec.indexOf("="); const ref = spec.slice(0, eq); const rest = spec.slice(eq + 1);
  const colon = rest.indexOf(":"); const adapter = colon < 0 ? rest : rest.slice(0, colon); const optText = colon < 0 ? "" : rest.slice(colon + 1);
  const opts = Object.fromEntries((optText ?? "").split(",").filter(Boolean).map((kv) => { const [k, ...v] = kv.split("="); return [k, v.join("=")]; }));
  const cv = published.find((v) => v.ref === ref);
  if (!cv) throw new Error(`course version ${ref} is not published in the app (npm run seed:courses)`);
  const needsModel = adapter !== "reference-control";
  const definition = {
    agent: { adapter, ...(opts.options ? { options: JSON.parse(opts.options) } : {}) },
    model: needsModel ? { provider: "openai-compatible", model: opts.model ?? "qwen2.5-coder-3b", ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), inference: { structuredOutput: "schema" } } : null,
    budgets: { ...recBudgets, ...(opts.budgets ? JSON.parse(opts.budgets) : {}) },
    obstacles: opts.obstacles && opts.obstacles !== "none" ? { enabled: true, ...(opts.obstacles !== "default" ? { overrides: { variant: opts.obstacles } } : {}) } : { enabled: false },
    environment: { kind: "local-isolated" },
  };
  const exp = await call("mutation", "experiments:save", { name: `e2e ${adapter} ${opts.model ?? ""}`.trim(), ...definition });
  const run = await call("mutation", "runs:launch", { experimentId: exp.experimentId, courseVersionId: cv.courseVersionId });
  console.log(`launched ${run.runId ?? JSON.stringify(run)}: ${ref} with ${adapter} (experiment ${exp.experimentId}, ${exp.digest})`);
  launched.push({ runId: run.runId, ref, adapter, label: opts.label ?? `${ref.replace("@", "-")}-${adapter}` });
}

// The harness itself: dispatcher + worker until nothing is pending, running or waiting.
const code = await new Promise((resolve) => {
  const c = spawn(process.execPath, ["harness/cli.mjs", "once"], { stdio: "inherit", env: { ...process.env, AOC_APP_URL: APP, AOC_HARNESS_API_KEY: KEY } });
  c.on("exit", resolve);
});
console.log(`harness once exited ${code}`);

for (const l of launched) {
  const r = await call("query", "runs:get", { runId: l.runId });
  const res = r.result ?? null;
  console.log(`${l.runId}: state ${r.state}, outcome ${r.outcome ?? res?.outcome}${res?.failureClass ? ` (${res.failureClass})` : ""}, acceptance ${res?.evaluation?.acceptance}`);
  if (EVDIR) {
    mkdirSync(EVDIR, { recursive: true });
    const events = await call("query", "runs:events", { runId: l.runId, tail: 200 }).catch((e) => ({ error: e.message }));
    const evidence = await call("query", "runs:evidenceIndex", { runId: l.runId }).catch((e) => ({ error: e.message }));
    const list = Array.isArray(events) ? events : events.events ?? [];
    const byKind = {}; for (const e of list) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    writeFileSync(join(EVDIR, `${l.label}.app.json`), JSON.stringify({
      recordedAt: new Date().toISOString(), mode: "end-to-end through the real FeltKit app (AppPort, harness API key) + Durable Work on feltdb-server 0.3.0",
      app: APP, runId: l.runId, course: l.ref, adapter: l.adapter, appRunState: r.state, appOutcome: r.outcome ?? null, workloadId: r.workloadId ?? null,
      result: res, eventsFromApp: { count: list.length, byKind, notable: list.filter((e) => ["obstacle.injected", "recovery", "claim", "cancel"].includes(e.kind) || e.source === "evaluator").map((e) => ({ seq: e.seq, source: e.source, kind: e.kind, summary: e.summary })).slice(0, 60) },
      evidenceFromApp: Array.isArray(evidence) ? evidence.map((i) => ({ evidenceId: i.evidenceId, kind: i.kind, digest: i.digest })) : evidence,
    }, null, 2) + "\n");
  }
}
