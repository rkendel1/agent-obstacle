#!/usr/bin/env node
// Harness entry points.
//   npm run harness:start                  dispatcher + worker loop against the app (AOC_APP_URL, AOC_HARNESS_API_KEY)
//   npm run harness:once                   same, until nothing is pending/running (tests, cron)
//   npm run harness:run -- --course course-000-calibration/v2 --adapter reference-control [options]
//                                          one run WITHOUT the app (local sink), optionally --durable (real work authority)
//   npm run harness:clean -- [--runs] [--fixtures]
//
// harness:run options: --adapter stack-agent|patch-agent|reference-control|null-control
//   --model qwen2.5-coder-3b --endpoint http://127.0.0.1:8080   (model upstream; the run gets its own proxy)
//   --max-turns N --max-executions N --deadline-secs N --call-timeout-secs N --max-output-tokens N
//   --obstacles default|none|<variant>   --option key=value (agent options, repeatable)   --run-id ID
//   --durable   --evidence docs/harness/runs/<name>.json (small JSON summary)   --keep-eval
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runsDir, fixturesDir, requireTool } from './lib/paths.mjs';
import { canonicalDigest, writeJSON, readJSON, readJSONL, nowIso } from './lib/util.mjs';
import { AppClient } from './app-client/index.mjs';
import { loadState, refreshGrants, startAuthority, authorityStatus } from './work-authority/authority.mjs';
import { attemptRequest } from './work-authority/client.mjs';
import { Dispatcher, overallMs } from './dispatcher/index.mjs';
import { AttemptExecutor } from './worker/executor.mjs';
import { AppSink, FileSink } from './worker/recorder.mjs';
import { runDirect } from './worker/direct.mjs';
import { experimentDigest } from './worker/stages.mjs';
import { loadCourseRef } from './courses/index.mjs';
import { getAdapter } from './agents/index.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function authority() {
  const state = loadState();
  if (!state?.complete) throw new Error('the work authority is not set up: npm run harness:authority:setup');
  await startAuthority();
  await refreshGrants(state, { log });
  return loadState();
}

export function buildExperiment({ adapter, model, endpoint, budgets, obstacles, options = {} }) {
  const a = getAdapter(adapter);
  const exp = {
    experimentId: 'local-cli', agent: { adapter, version: a.version?.() ?? undefined, options },
    model: a.needsModel ? { provider: 'openai-compatible', model: model ?? 'qwen2.5-coder-3b', ...(endpoint ? { endpoint } : {}), inference: { structuredOutput: options.structuredOutput ?? 'schema' } } : null,
    budgets, obstacles: obstacles === 'none' ? { enabled: false } : obstacles === 'default' ? { enabled: true } : { enabled: true, overrides: { variant: obstacles } },
    environment: { kind: 'local-isolated' },
  };
  exp.digest = experimentDigest(exp);
  return exp;
}

function parseOptions() {
  const out = {};
  argv.forEach((a, i) => { if (a === '--option') { const [k, ...v] = argv[i + 1].split('='); const s = v.join('='); out[k] = /^\d+$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s; } });
  return out;
}

/** Small JSON summary of a run for docs/harness/runs/ (no secrets, no prompt bodies, no large logs). */
export function runSummary(runDir, extra = {}) {
  const result = readJSON(join(runDir, 'result.json'), null);
  const events = readJSONL(join(runDir, 'events.jsonl'));
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const notable = events.filter((e) => ['obstacle.injected', 'recovery', 'cancel', 'claim', 'budget', 'agent.launch'].includes(e.kind) || (e.kind === 'verification' && e.source === 'evaluator') || (e.kind === 'stage' && /failed|reported/.test(e.summary))).map((e) => ({ seq: e.seq, source: e.source, kind: e.kind, summary: e.summary }));
  const evidence = readJSONL(join(runDir, 'evidence.jsonl')).map((i) => ({ evidenceId: i.evidenceId, kind: i.kind, source: i.source, digest: i.digest, path: i.path }));
  const uniqEvidence = [...new Map(evidence.map((e) => [e.evidenceId, e])).values()];
  return { recordedAt: nowIso(), ...extra, runDir, result, events: { total: events.length, byKind, notable: notable.slice(0, 80) }, evidence: uniqEvidence };
}

async function runLocal() {
  const course = loadCourseRef(opt('course', 'course-000-calibration/v2'));
  const adapter = opt('adapter', 'reference-control');
  const rec = course.doc.meta?.recommendedBudgets ?? { maxTurns: 12, maxExecutions: 10, deadlineSecs: 900, callTimeoutSecs: 300 };
  const budgets = {
    maxTurns: Number(opt('max-turns', rec.maxTurns)), maxExecutions: Number(opt('max-executions', rec.maxExecutions)), deadlineSecs: Number(opt('deadline-secs', rec.deadlineSecs)),
    callTimeoutSecs: Number(opt('call-timeout-secs', rec.callTimeoutSecs ?? 300)), ...(opt('max-output-tokens', rec.maxOutputTokens) ? { maxOutputTokens: Number(opt('max-output-tokens', rec.maxOutputTokens)) } : {}),
  };
  const experiment = buildExperiment({ adapter, model: opt('model'), endpoint: opt('endpoint'), budgets, obstacles: opt('obstacles', course.doc.obstacles?.default?.length ? 'default' : 'none'), options: parseOptions() });
  const runId = opt('run-id', `run-${course.id.split('-').slice(0, 2).join('')}-${adapter}-${Date.now().toString(36)}`);
  const runDir = join(runsDir(), runId);
  const input = { runId, courseVersionId: `${course.id}@${course.version}`, courseDigest: course.digest, experiment, requestedAt: nowIso(), requestedBy: 'harness:run' };
  const sink = new FileSink(runDir);
  log(`run ${runId}: ${course.id}/${course.version} with ${adapter} (${flag('durable') ? 'durable' : 'direct'}); run dir ${runDir}`);
  let outcome;
  if (flag('durable')) {
    const state = await authority();
    const exec = new AttemptExecutor({ state, sink, log });
    const w = await exec.c.app.create(attemptRequest({ state, runId, input, overallMs: overallMs(experiment) }));
    log(`admitted workload ${w.workload_id}`);
    const r = await exec.execute(w.workload_id, { runId });
    outcome = r.result?.outcome;
  } else {
    const r = await runDirect({ runId, input, sink, log });
    outcome = r.result?.outcome;
  }
  const result = readJSON(join(runDir, 'result.json'), null);
  log(`run ${runId}: outcome ${outcome}${result?.failureClass ? ` (${result.failureClass})` : ''}; acceptance ${result?.evaluation?.acceptance}, regression ${result?.evaluation?.regression}`);
  const ev = opt('evidence');
  if (ev) {
    mkdirSync(dirname(ev), { recursive: true });
    writeJSON(ev, runSummary(runDir, { mode: flag('durable') ? 'durable (real work authority, local sink: no app)' : 'direct (no work authority, local sink: no app)', course: `${course.id}/${course.version}`, adapter, experiment }));
    log(`evidence summary written to ${ev}`);
  }
  process.exitCode = outcome ? 0 : 1;
}

async function main() {
  switch (cmd) {
    case 'start':
    case 'once': {
      requireTool('pax'); // every run observes with PAX; Stack-Agent is checked when a run uses it
      const state = await authority();
      const app = AppClient.fromEnv();
      const d = new Dispatcher({ app, state, sink: new AppSink(app), log });
      process.on('SIGTERM', () => d.stop()); process.on('SIGINT', () => d.stop());
      if (cmd === 'start') await d.start(); else log(`once: ${JSON.stringify(await d.once())}`);
      break;
    }
    case 'run': await runLocal(); break;
    case 'status': console.log(JSON.stringify({ authority: await authorityStatus(), runsDir: runsDir(), fixturesDir: fixturesDir(), app: process.env.AOC_APP_URL ?? null }, null, 2)); break;
    case 'clean': {
      if (flag('runs') && existsSync(runsDir())) { rmSync(runsDir(), { recursive: true, force: true }); log(`removed ${runsDir()}`); }
      if (flag('fixtures') && existsSync(fixturesDir())) { rmSync(fixturesDir(), { recursive: true, force: true }); log(`removed ${fixturesDir()}`); }
      break;
    }
    default:
      console.error('usage: cli.mjs start | once | run [options] | status | clean [--runs] [--fixtures]');
      process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e.stack ?? e.message); process.exitCode = 1; });
