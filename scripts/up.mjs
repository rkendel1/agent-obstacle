#!/usr/bin/env node
/**
 * npm run dev — the whole Agent Obstacle Course on this machine, in one command.
 *
 *   1. tools: feltdb-server 0.3.0 and pax (required), stack-agent (for Stack-Agent runs), cargo / pnpm (for the
 *      courses' toolchains). Missing ones are installed with cargo on the first run (--no-install to skip).
 *   2. the FeltKit app (`feltkit dev`, http://127.0.0.1:3000, Studio at /_feltkit);
 *   3. the courses (`seed:courses`, idempotent);
 *   4. the work authority (local feltdb-server: set up once, then started);
 *   5. the harness's API key (created once in .harness/harness-api-key, re-created when the app no longer knows it);
 *   6. optionally a local model server (--local-model 3b|1.5b);
 *   7. the harness dispatcher + worker.
 * Logs are prefixed [app] / [harness]. Ctrl-C stops everything this command started.
 *
 * Model keys: enter them in Studio → Models; the harness reads them from this checkout's development vault
 * (or FELTKIT_CREDENTIAL_<ID>, which wins). `npm run dev:app` starts only the FeltKit app.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { PROJECT_DIR } from "./devtools.mjs";
import { locate, TOOL_FALLBACKS } from "../harness/lib/paths.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const say = (m) => console.log(`\x1b[1m[aoc]\x1b[0m ${m}`);
const fail = (m) => { console.error(`\x1b[31m[aoc]\x1b[0m ${m}`); shutdown(1); };
const children = [];
let stopping = false;

// ---------------------------------------------------------------------------------------------- 1. tools
// The exact builds the harness runs, installed with cargo into ~/.cargo/bin. A different build already there is
// replaced; AOC_PAX_BIN / AOC_STACK_AGENT_BIN / FELTDB_SERVER_BIN still choose another binary on purpose.
const PINS = {
  "feltdb-server": { tool: "feltdbServer", pkg: "feltdb-server", source: "0.3.0", required: true, install: ["install", "feltdb-server", "--version", "0.3.0", "--locked"] },
  pax: { tool: "pax", pkg: "pax", source: "rev=c70680c", required: true, install: ["install", "--git", "https://github.com/rkendel1/pax", "--rev", "c70680c", "--locked", "pax"] },
  "stack-agent": { tool: "stackAgent", pkg: "stack-agent", source: "rev=35d7af2", required: false, install: ["install", "--git", "https://github.com/rkendel1/stack-agent", "--rev", "35d7af2", "--locked", "--bin", "stack-agent", "stack-agent"], why: "Stack-Agent runs" },
};
const cargoBin = join(homedir(), ".cargo", "bin");
process.env.PATH = [cargoBin, join(homedir(), ".local", "bin"), process.env.PATH].join(":");
const onPath = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || null;
const located = (name) => { const p = locate(...TOOL_FALLBACKS[PINS[name].tool]); return existsSync(p) ? p : null; };

/** Whether cargo installed exactly the pinned build of `pin.pkg` (~/.cargo/.crates2.json). */
function pinnedInstalled(pin) {
  try {
    const installs = JSON.parse(readFileSync(join(homedir(), ".cargo", ".crates2.json"), "utf8")).installs ?? {};
    return Object.keys(installs).some((k) => k.startsWith(`${pin.pkg} `) && (pin.source.startsWith("rev=") ? k.includes(`?${pin.source}#`) : k.startsWith(`${pin.pkg} ${pin.source} (`)));
  } catch { return false; }
}

async function tools() {
  for (const [name, pin] of Object.entries(PINS)) {
    const override = process.env[TOOL_FALLBACKS[pin.tool][0]];
    if (override) {
      if (existsSync(override)) { say(`${name}: using ${override} (${TOOL_FALLBACKS[pin.tool][0]})`); continue; }
      if (pin.required) return fail(`${TOOL_FALLBACKS[pin.tool][0]}=${override} does not exist.`);
    }
    const target = join(cargoBin, name);
    if (existsSync(target) && pinnedInstalled(pin)) { process.env[TOOL_FALLBACKS[pin.tool][0]] = target; continue; }
    const why = existsSync(target) ? `replacing ${name} in ~/.cargo/bin with the pinned build (${pin.source})` : `installing ${name} (${pin.source}) with cargo`;
    if (has("--no-install") || !onPath("cargo")) {
      const how = onPath("cargo") ? `cargo ${pin.install.join(" ")} --force` : "install Rust from https://rustup.rs, then rerun npm run dev";
      if (located(name)) { say(`${name}: using ${located(name)}, which may not be the pinned build (${how})`); process.env[TOOL_FALLBACKS[pin.tool][0]] = located(name); continue; }
      if (pin.required) return fail(`${name} is required and not installed. ${how}`);
      say(`${name} not installed: ${pin.why} will end BLOCKED until it is (${how}).`);
      continue;
    }
    say(`${why} (this can take several minutes)…`);
    // Git installs use the machine's own git credentials (private repositories).
    const r = spawnSync("cargo", [...pin.install, "--force"], { stdio: "inherit", env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_NET_GIT_FETCH_WITH_CLI: "true" } });
    if (r.status !== 0 || !existsSync(target)) {
      if (pin.required && !located(name)) return fail(`installing ${name} failed. Run: cargo ${pin.install.join(" ")} --force`);
      say(`installing ${name} failed${located(name) ? `; using ${located(name)}` : `: ${pin.why} will end BLOCKED`}. Run: cargo ${pin.install.join(" ")} --force`);
      if (located(name)) process.env[TOOL_FALLBACKS[pin.tool][0]] = located(name);
      continue;
    }
    process.env[TOOL_FALLBACKS[pin.tool][0]] = target;
  }
  for (const [name, use] of [["cargo", "course-000 (Rust)"], ["pnpm", "course-001 (T4)"], ["git", "fixtures"]]) {
    if (!onPath(name)) say(`${name} not found: ${use} cannot be prepared or evaluated.`);
  }
  for (const name of Object.keys(PINS)) {
    const p = process.env[TOOL_FALLBACKS[PINS[name].tool][0]];
    if (p) say(`${name}: ${spawnSync(p, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || p}`);
  }
}

// ---------------------------------------------------------------------------------------------- leftovers
/** Working directory of a process (Linux /proc, macOS lsof), or null. */
function cwdOf(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not Linux */ }
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
}

/** App, harness and work-authority processes of THIS checkout left from an earlier start (another terminal, a crash). */
function leftovers() {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  const found = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]); const cmd = m[2];
    if (pid === process.pid || pid === process.ppid) continue;
    const what = /harness\/cli\.mjs (start|once)/.test(cmd) ? "harness"
      : /feltkit(\.js)? dev\b/.test(cmd) && !/scripts\/up\.mjs/.test(cmd) ? "app"
      : /scripts\/up\.mjs/.test(cmd) && !/^(sh|npm)/.test(cmd) ? "npm run dev"
      : /feltdb-server .*--namespace aoc/.test(cmd) ? "work authority" : null;
    if (!what) continue;
    const mine = cmd.includes(PROJECT_DIR) || cwdOf(pid) === PROJECT_DIR;
    if (mine) found.push({ pid, what });
  }
  return found;
}

async function stopLeftovers() {
  const found = leftovers();
  if (!found.length) return;
  say(`stopping what an earlier start left running here: ${found.map((f) => `${f.what} (pid ${f.pid})`).join(", ")}`);
  for (const f of found) { try { process.kill(f.pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 40 && found.some((f) => alive(f.pid)); i++) await sleep(250);
  for (const f of found.filter((f) => alive(f.pid))) { try { process.kill(f.pid, "SIGKILL"); } catch { /* gone */ } }
  await sleep(500);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------------------------------------- helpers
function start(label, cmd, argv, env = {}) {
  const child = spawn(cmd, argv, { cwd: PROJECT_DIR, env: { ...process.env, ...env, FORCE_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const prefix = `\x1b[36m[${label}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) process.stdout.write(prefix + l + "\n"); });
  }
  child.on("exit", (code, signal) => { if (!stopping) fail(`${label} stopped (${signal ?? `exit ${code}`}).`); });
  children.push(child);
  return child;
}

function node(script, argv = [], env = {}) {
  const r = spawnSync(process.execPath, [script, ...argv], { cwd: PROJECT_DIR, env: { ...process.env, ...env }, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

async function appUrl() {
  const file = join(PROJECT_DIR, ".feltkit", "development", "runtime.json");
  for (let i = 0; i < 240; i++) {
    try {
      const rec = JSON.parse(readFileSync(file, "utf8"));
      process.kill(rec.pid, 0);
      const url = (rec.url ?? "http://127.0.0.1:3000").replace(/\/$/, "").replace("localhost", "127.0.0.1");
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (r) return url;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return fail("the FeltKit app did not come up within 2 minutes (see the [app] lines above).");
}

async function keyWorks(url, key) {
  const r = await fetch(`${url}/appport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `up-${Date.now()}`, capability: { name: "runs.pending", version: 1 }, input: { limit: 1 } }),
  }).catch(() => null);
  if (!r) return false;
  const body = await r.json().catch(() => null);
  return Boolean(body?.ok);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } }
  const stop = node(join(PROJECT_DIR, "harness/work-authority/cli.mjs"), ["stop"]);
  if (has("--local-model")) node(join(PROJECT_DIR, "harness/model-proxy/cli.mjs"), ["stop"]);
  if (code === 0) say(`stopped (${stop.out.replace(/^\[authority\] /, "work authority: ")})`);
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---------------------------------------------------------------------------------------------- run
await tools();
if (stopping) await sleep(1e9);

await stopLeftovers();
say("starting the FeltKit app…");
start("app", process.execPath, [join(PROJECT_DIR, "node_modules", "@feltdb", "feltkit", "bin", "feltkit.js"), "dev", ...(opt("--port") ? ["--port", opt("--port")] : [])]);
const url = await appUrl();
say(`app is up at ${url}`);

const seeded = node(join(PROJECT_DIR, "scripts/seed-courses.mjs"));
if (!seeded.ok) fail(`publishing the courses failed:\n${seeded.out}`);
for (const l of seeded.out.split("\n").filter((l) => /^\s+[=+·!]/.test(l))) say(`course ${l.trim().replace(/\s+sha256:\S+/, "").replace(/\s+\(courses\/.*\)$/, "")}`);

const authority = node(join(PROJECT_DIR, "harness/work-authority/cli.mjs"), ["status"]);
const setUp = authority.ok || /"setUp":\s*true/.test(authority.out);
const a = setUp ? node(join(PROJECT_DIR, "harness/work-authority/cli.mjs"), ["start"]) : (say("setting up the work authority (first run only)…"), node(join(PROJECT_DIR, "harness/work-authority/cli.mjs"), ["setup"]));
if (!a.ok) fail(`work authority: ${a.out}`);
say(a.out.split("\n").pop().replace(/^\[authority\] /, "work authority: "));

mkdirSync(join(PROJECT_DIR, ".harness"), { recursive: true });
const keyFile = join(PROJECT_DIR, ".harness", "harness-api-key");
let key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
if (!key || !(await keyWorks(url, key))) {
  const k = node(join(PROJECT_DIR, "scripts/harness-key.mjs"), ["--out", keyFile]);
  if (!k.ok) fail(`creating the harness API key failed:\n${k.out}`);
  key = readFileSync(keyFile, "utf8").trim();
  if (!(await keyWorks(url, key))) fail("the new harness API key is refused by the app.");
  say("harness API key created (.harness/harness-api-key)");
}

if (has("--local-model")) {
  const m = node(join(PROJECT_DIR, "harness/model-proxy/cli.mjs"), ["start", "--model", opt("--local-model")]);
  if (!m.ok) fail(`local model server: ${m.out}`);
  say(m.out.split("\n").pop());
}

start("harness", process.execPath, [join(PROJECT_DIR, "harness/cli.mjs"), "start"], { AOC_APP_URL: url, AOC_HARNESS_API_KEY: key });
say(`ready. Open ${url}; Studio is the Dashboard link in the [app] lines above (model and API keys: Studio → Models). Ctrl-C stops everything.`);
