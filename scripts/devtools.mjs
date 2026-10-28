/**
 * Development helpers shared by the scripts in this directory.
 *
 * withAdmin(work) gives `work` an `admin` handle acting as the development admin (ada):
 *   - when `npm run dev` is running (.feltkit/development/runtime.json), over HTTP: a
 *     development sign-in session, AppPort capability calls on POST /appport, and the
 *     AppPort Services console for API keys;
 *   - otherwise, by opening the development environment directly (as the feltkit CLI does).
 * Development only: development sign-in and the services console do not exist elsewhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const PROJECT_DIR = resolve(new URL("..", import.meta.url).pathname);
const RUNTIME_DIR = join(PROJECT_DIR, ".feltkit", "development");
const ADMIN = { id: "ada", type: "user", roles: ["admin"], displayName: "Ada Lovelace" };

function runningServer() {
  if (process.env.FELTKIT_URL) return { url: process.env.FELTKIT_URL.replace(/\/$/, ""), pid: null };
  const file = join(RUNTIME_DIR, "runtime.json");
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    process.kill(record.pid, 0);
    return record;
  } catch {
    return null;
  }
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${response.url} answered ${response.status}: ${text.slice(0, 200)}`);
  }
}

function remoteAdmin(server) {
  let token = null;
  const session = async () => {
    if (token) return token;
    const r = await fetch(`${server.url}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: ADMIN.id }) });
    const body = await json(r);
    if (!r.ok) throw new Error(`Development sign-in as ${ADMIN.id} failed: ${body?.error?.message ?? r.status}`);
    return (token = body.token);
  };
  return {
    mode: `running server ${server.url}`,
    async invoke(capability, input, idempotencyKey) {
      const r = await fetch(`${server.url}/appport`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await session()}` },
        body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: randomUUID(), capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      });
      const body = await json(r);
      if (!body.ok) throw Object.assign(new Error(`${capability}: ${body.error?.code} ${body.error?.message}`), { error: body.error });
      return body.output;
    },
    async modelStatus() {
      const adminToken = readFileSync(join(RUNTIME_DIR, "admin-token"), "utf8").trim();
      const r = await fetch(`${server.url}/_feltkit/api/models`, { headers: { "x-feltkit-admin": adminToken } });
      const body = await json(r);
      if (!r.ok) throw new Error(`Studio admin API: ${body?.error?.message ?? r.status}`);
      return body.status;
    },
    async createApiKey(name) {
      // The AppPort Services console (the package's own API-key routes), signed in as ada.
      const adminToken = readFileSync(join(RUNTIME_DIR, "admin-token"), "utf8").trim();
      const r = await fetch(`${server.url}/_feltkit/api/services/console`, { method: "POST", headers: { "x-feltkit-admin": adminToken, "content-type": "application/json" }, body: JSON.stringify({ as: ADMIN.id, page: "/api-keys" }) });
      const body = await json(r);
      if (!r.ok) throw new Error(`Services console: ${body?.error?.message ?? r.status}`);
      const ticket = new URL(body.url);
      const login = await fetch(ticket, { redirect: "manual" });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      if (!cookie) throw new Error("The services console did not issue a session.");
      const created = await fetch(`${ticket.origin}/_appport/api/keys`, { method: "POST", headers: { cookie, origin: ticket.origin, "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const key = await json(created);
      if (!created.ok) throw new Error(`Creating the API key failed: ${key?.error?.message ?? created.status}`);
      return key;
    },
    async close() {
      if (token) await fetch(`${server.url}/api/auth/signout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    },
  };
}

async function directAdmin() {
  const { FeltKitRuntime, loadSources, resolveEnvironment } = await import("@feltdb/feltkit/server");
  const project = await loadSources(PROJECT_DIR);
  const environment = resolveEnvironment({ projectDir: PROJECT_DIR, appName: project.app.name, name: "development" });
  const quiet = { info() {}, warn() {}, error: (m) => console.error(m), debug() {} };
  const runtime = await FeltKitRuntime.start({ project, environment, logger: quiet });
  const byCapability = new Map(runtime.functions().filter((f) => f.capability).map((f) => [f.capability.name, f.name]));
  return {
    mode: "opened the development environment directly (no server running)",
    async invoke(capability, input) {
      const name = byCapability.get(capability);
      if (!name) throw new Error(`No capability ${capability}`);
      const result = await runtime.call(name, input, { principal: ADMIN, via: "cli" });
      if (!result.ok) throw Object.assign(new Error(`${capability}: ${result.error.code} ${result.error.message}`), { error: result.error });
      return result.value;
    },
    modelStatus: () => runtime.models.status(),
    createApiKey: (name) => runtime.services.asPrincipal(ADMIN, (verified) => runtime.services.apiKeys.createApiKey({ name }, verified)),
    close: () => runtime.close(),
  };
}

export async function withAdmin(work) {
  const server = runningServer();
  const admin = server ? remoteAdmin(server) : await directAdmin();
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

/** Record the environment's Intelligence selection in the app (never a secret value). */
export async function syncModel(admin) {
  const status = await admin.modelStatus();
  const observation = {
    ready: Boolean(status.ready),
    source: String(status.source ?? "none"),
    provider: status.provider ?? null,
    model: status.model ?? null,
    endpoint: status.endpoint ?? null,
    protocol: status.protocol ?? null,
    credentialRef: status.credential?.ref ?? null,
    credentialPresent: Boolean(status.credential?.present),
    problems: (status.problems ?? []).map((p) => String(p.message ?? p.problem ?? p)).slice(0, 20),
  };
  await admin.invoke("models.environment.record", observation, `model-sync-${randomUUID()}`);
  return observation;
}
