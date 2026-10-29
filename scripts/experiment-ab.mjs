#!/usr/bin/env node
/**
 * npm run experiment:ab -- [--plan experiments/ab-adaptive-context-v1.json] [--stage <id>]
 *                          [--launch --confirm-paid] [--app http://127.0.0.1:3000]
 *
 * Without --launch: validates the plan against this machine (the selected Stack-Agent build is installed and
 * supports every arm's options) and prints the exact experiment definitions, the run order, the projected number
 * of model calls and a cost range. Nothing is saved or launched and no model is called.
 *
 * With --launch --confirm-paid (and --stage): saves one experiment per arm × model in the running app and launches
 * the stage's runs in ABBA order through the normal path (the harness started by `npm run dev` picks them up).
 * Paid model calls happen from that point on, so both flags are required.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_DIR } from "./devtools.mjs";
import { resolveStackAgentConfig } from "../harness/agents/stack-agent-config.mjs";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const plan = JSON.parse(readFileSync(resolve(PROJECT_DIR, opt("--plan", "experiments/ab-adaptive-context-v1.json")), "utf8"));
const stages = plan.stages.filter((s) => !opt("--stage") || s.id === opt("--stage"));
if (!stages.length) { console.error(`no stage ${opt("--stage")} in ${plan.id}`); process.exit(2); }

/** The experiment definition for one arm and model: identical except agent.options.contextProfile and runLabel. */
function definition(stage, armId, model) {
  const f = plan.heldFixed;
  return {
    name: `${plan.id} ${stage.id} ${model} ${armId}`,
    notes: `${plan.id}: ${plan.question} Stage ${stage.id}, arm ${armId}. Pre-registered plan: experiments/${plan.id}.json`,
    agent: { adapter: "stack-agent", options: { build: plan.build, ...plan.arms[armId], promptCache: f.promptCache, runLabel: `${plan.id}.${stage.id}.${armId}`, ...(f.durableState === false ? { durableState: false } : {}) } },
    model: { provider: f.provider, model, endpoint: f.endpoint, credentialRef: f.credentialRef },
    budgets: f.budgets,
    obstacles: stage.obstacle === "none" ? { enabled: false } : { enabled: true, ...(stage.obstacle !== "default" ? { overrides: { variant: stage.obstacle } } : {}) },
    environment: f.environment,
  };
}

/** ABBA order: replay, auto, auto, replay, replay, auto, ... */
function order(runsPerArm) {
  const [a, b] = Object.keys(plan.arms);
  const out = [];
  for (let i = 0; out.length < runsPerArm * 2; i++) out.push(...(i % 2 === 0 ? [a, b] : [b, a]));
  return out;
}

/**
 * Cost range for one run from the baseline: upper = every input token billed as ordinary input (no cache hit);
 * lower = linear context growth, so the final context (~2 × total / calls) is written to the cache once and the
 * rest of the input is read from it. Both are projections, not measurements.
 */
function costRange(model, base) {
  const p = plan.pricingUsdPerMTok[model];
  if (!p || !base) return null;
  const out = (base.outputTokens * p.output) / 1e6;
  const upper = (base.inputTokens * p.input) / 1e6 + out;
  const finalContext = Math.min(base.inputTokens, (2 * base.inputTokens) / base.calls);
  const lower = (finalContext * p.cacheWrite + (base.inputTokens - finalContext) * p.cacheRead) / 1e6 + out;
  return { lower, upper };
}
const baselineFor = (stage, model) => plan.baseline[`${stage.id} ${model}${stage.obstacle !== "default" ? ` ${stage.obstacle}` : ""}`] ?? plan.baseline[`${stage.id} ${model}`];
const usd = (x) => `$${x.toFixed(2)}`;

let checked = 0;
for (const [armId, arm] of Object.entries(plan.arms)) {
  const cfg = resolveStackAgentConfig({ build: plan.build, ...arm, promptCache: plan.heldFixed.promptCache, runLabel: `${plan.id}.check.${armId}` });
  console.log(`arm ${armId}: stack-agent ${cfg.binary.version} build ${cfg.binary.build}@${cfg.binary.commit} sha256 ${cfg.binary.sha256} (${cfg.binary.path}); --context-profile ${cfg.contextProfile} --prompt-cache ${cfg.promptCache}`);
  checked++;
}
let totalCalls = 0, totalLower = 0, totalUpper = 0;
for (const stage of stages) {
  console.log(`\nstage ${stage.id}: ${stage.course}, obstacle ${stage.obstacle}, ${stage.runsPerArm} runs per arm${stage.gate ? ` — gate: ${stage.gate}` : ""}`);
  for (const model of stage.models) {
    const seq = order(stage.runsPerArm);
    const base = baselineFor(stage, model);
    const range = costRange(model, base);
    const calls = base ? base.calls * seq.length : null;
    totalCalls += calls ?? 0;
    if (range) { totalLower += range.lower * seq.length; totalUpper += range.upper * seq.length; }
    console.log(`  ${model}: order ${seq.join(", ")}`);
    console.log(`    projected model calls ≈ ${calls ?? "unknown"} (baseline ${base?.calls ?? "?"} per run); cost ≈ ${range ? `${usd(range.lower * seq.length)}–${usd(range.upper * seq.length)} (${usd(range.lower)}–${usd(range.upper)} per run)` : "unknown"}`);
    for (const armId of Object.keys(plan.arms)) console.log(`    ${armId}: ${JSON.stringify(definition(stage, armId, model))}`);
  }
}
console.log(`\nselected stages: ≈ ${totalCalls} model calls, ≈ ${usd(totalLower)}–${usd(totalUpper)} (projection from the ${plan.baseline.source}; the real spend is what the provider reports).`);

if (!has("--launch")) { console.log("\nDry run: nothing saved, nothing launched, no model called."); process.exit(0); }
if (!has("--confirm-paid") || !opt("--stage")) { console.error("--launch needs --stage <id> and --confirm-paid (paid model calls)."); process.exit(2); }

const APP = opt("--app", "http://127.0.0.1:3000").replace(/\/$/, "");
const login = await fetch(`${APP}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "ada" }) });
const { token } = await login.json();
const call = async (kind, name, a = {}) => {
  const r = await fetch(`${APP}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ args: a }) });
  const b = await r.json();
  if (!b.ok) throw new Error(`${name}: ${JSON.stringify(b.error ?? b)}`);
  return b.value;
};
const published = await call("query", "courses:published");
for (const stage of stages) {
  const cv = published.find((v) => v.ref === stage.course);
  if (!cv) throw new Error(`${stage.course} is not published in the app (npm run seed:courses)`);
  for (const model of stage.models) {
    const experiments = {};
    for (const armId of Object.keys(plan.arms)) experiments[armId] = await call("mutation", "experiments:save", definition(stage, armId, model));
    for (const [i, armId] of order(stage.runsPerArm).entries()) {
      const run = await call("mutation", "runs:launch", { experimentId: experiments[armId].experimentId, courseVersionId: cv.courseVersionId });
      console.log(JSON.stringify({ plan: plan.id, stage: stage.id, model, arm: armId, seq: i + 1, runId: run.runId, experimentId: experiments[armId].experimentId, experimentDigest: experiments[armId].digest }));
    }
  }
}
