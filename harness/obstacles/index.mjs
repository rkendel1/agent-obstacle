// Deterministic obstacle injection, defined by the course (obstacles.default / obstacles.variants).
//
// v1 obstacle types:
//  * transient-test-failure  — the PAX shim on the agent's PATH fails the first N `pax test` calls
//                              transiently (exit 75, status error, reason transient-infrastructure-failure).
//  * process-interruption    — the harness SIGKILLs the agent's process group when a trigger fires
//                              ({event: "pax.test"|"model.call", count} or {afterSecs}) and relaunches
//                              it with the same task id (Stack-Agent resume) once its lease expires.
//  * worker-interruption     — test/fault tool: the harness worker SIGKILLs itself at a stage boundary
//                              or mid-stage (AOC_FAULT_KILL=<stage>:after|<ms>), exercising Durable Work
//                              lease expiry, reclaim with a higher fence and resume from checkpoint.
// Every injection is recorded as an `obstacle.injected` event (source: harness).
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../lib/paths.mjs';
import { readJSONL, writeJSON } from '../lib/util.mjs';

export const SHIM = fileURLToPath(new URL('./pax-shim.mjs', import.meta.url));
export const OBSTACLE_TYPES = ['transient-test-failure', 'process-interruption'];

/** The obstacle schedule for a run: course default, or a named variant (experiment.obstacles.overrides.variant). */
export function obstacleSchedule(courseDoc, experimentObstacles) {
  if (!experimentObstacles?.enabled) return [];
  const variant = experimentObstacles.overrides?.variant;
  const list = variant ? courseDoc.obstacles?.variants?.[variant] : courseDoc.obstacles?.default;
  if (variant && !list) throw Object.assign(new Error(`course has no obstacle variant "${variant}"`), { failureClass: 'harness' });
  for (const o of list ?? []) if (!OBSTACLE_TYPES.includes(o.type)) throw Object.assign(new Error(`unknown obstacle type ${o.type}`), { failureClass: 'harness' });
  return list ?? [];
}

/**
 * Install the PAX shim into <binDir>/pax. Returns { bin, log, config }. The shim is installed for
 * every run (it is also the harness's observation of the agent's PAX calls); it only injects when
 * the schedule has a transient-test-failure.
 */
export function installPaxShim({ binDir, logPath, schedule, interruptViaShim = false, pgidFile = null }) {
  mkdirSync(binDir, { recursive: true });
  const tf = schedule.find((o) => o.type === 'transient-test-failure');
  const pi = interruptViaShim ? schedule.find((o) => o.type === 'process-interruption' && o.params?.trigger?.event === 'pax.test') : null;
  const config = {
    realPax: TOOLS.pax, log: logPath,
    testFailures: tf ? { obstacleId: tf.id, failFirst: tf.params?.failFirst ?? 1, exitCode: tf.params?.exitCode ?? 75 } : null,
    interrupt: pi ? { obstacleId: pi.id, afterTests: pi.params.trigger.count ?? 1, marker: `${logPath}.interrupted`, pgidFile } : null,
  };
  const configPath = join(binDir, '.pax-shim.json');
  writeJSON(configPath, config);
  const bin = join(binDir, 'pax');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${SHIM}' --aoc-config '${configPath}' -- "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, log: logPath, config };
}

/** Summarize the shim log: test invocations and injections. */
export function paxShimSummary(logPath) {
  const entries = existsSync(logPath) ? readJSONL(logPath) : [];
  const tests = entries.filter((e) => e.op === 'test' && e.phase === 'end');
  return {
    entries,
    tests: tests.map((t) => ({ n: t.n, injected: !!t.injected, exit: t.exit ?? null, status: t.status ?? null, reason: t.reason ?? null, tests: t.tests ?? null, ms: t.ms })),
    injections: tests.filter((t) => t.injected),
    interrupts: entries.filter((e) => e.op === 'interrupt'),
    lastReal: [...tests].reverse().find((t) => !t.injected) ?? null,
  };
}

/** Recovery assessment for transient-test-failure, from observation only (never the agent's claim). */
export function assessTransientRecovery(obstacle, shim) {
  const injected = shim.injections.length > 0;
  if (!injected) return { obstacleId: obstacle.id, injected: false, recognized: null, recovered: null, detail: 'the agent never ran `pax test`, so the obstacle was not triggered' };
  const lastInjected = Math.max(...shim.injections.map((t) => t.n));
  const after = shim.tests.filter((t) => t.n > lastInjected);
  const real = after.filter((t) => !t.injected);
  return {
    obstacleId: obstacle.id, injected: true,
    recognized: after.length > 0,
    recovered: real.length > 0 && real.some((t) => t.status && t.status !== 'error'),
    detail: `${shim.injections.length} injected failure(s); ${after.length} later pax test call(s)${real.length ? `, last real status ${real.at(-1).status}` : ''}`,
  };
}

/** Parse AOC_FAULT_KILL=<stage>:after|<ms> (harness-worker interruption, tests and drills). */
export function workerFaultPlan(env = process.env) {
  const v = env.AOC_FAULT_KILL;
  if (!v) return null;
  const [stage, when = 'after'] = v.split(':');
  return { stage, when: when === 'after' ? 'after' : Number(when) };
}
