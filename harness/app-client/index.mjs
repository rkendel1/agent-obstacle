// Thin AppPort client for the harness ↔ app contract (docs/contracts/harness-app.md).
//
// Wire format (AppPort `appport/1` over HTTP, as served by @feltdb/feltkit 0.2.0's server through
// @appport/server's HttpBinding): POST {AOC_APP_URL}/appport with a JSON request envelope
//   { protocol: "appport/1", type: "request", requestId, capability: { name, version }, input, idempotencyKey? }
// and `Authorization: Bearer <AppPort Services API key>` (roles ["harness"]). The reply is a
// response envelope { type: "response", requestId, ok: true, output } | { ok: false, error: { code, message } }.
// The envelope is authoritative over the HTTP status (AppPort §26).
import { randomUUID } from 'node:crypto';

export class AppPortError extends Error {
  constructor(code, message, { capability, httpStatus, retryable, details } = {}) {
    super(`${capability ?? 'appport'}: ${code}: ${message}`);
    this.code = code; this.capability = capability; this.httpStatus = httpStatus; this.retryable = !!retryable; this.details = details;
  }
}

export class AppClient {
  /** @param {{url: string, apiKey: string, timeoutMs?: number, fetch?: typeof fetch}} opts */
  constructor({ url, apiKey, timeoutMs = 30_000, fetch: f = globalThis.fetch }) {
    if (!url) throw new Error('AOC_APP_URL is not set');
    if (!apiKey) throw new Error('AOC_HARNESS_API_KEY is not set');
    this.endpoint = url.replace(/\/+$/, '').replace(/\/appport$/, '') + '/appport';
    this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.fetch = f;
  }

  static fromEnv(env = process.env) {
    return new AppClient({ url: env.AOC_APP_URL, apiKey: env.AOC_HARNESS_API_KEY });
  }

  /** Mutations: CONFLICT (a concurrent FeltDB commit; nothing written) is retried with backoff, bounded. */
  async call(name, version, input, opts = {}) {
    for (let i = 0; ; i++) {
      try { return await this.#call(name, version, input, opts); }
      catch (e) {
        if (!opts.idempotencyKey || e.code !== 'CONFLICT' || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      }
    }
  }

  async #call(name, version, input, { idempotencyKey } = {}) {
    const envelope = { protocol: 'appport/1', type: 'request', requestId: `req_${randomUUID()}`, capability: { name, version }, input, ...(idempotencyKey ? { idempotencyKey } : {}) };
    let res;
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
    } catch (e) {
      throw new AppPortError('UNREACHABLE', `the app endpoint is unreachable (${e.message})`, { capability: `${name}@${version}`, retryable: true });
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new AppPortError('INTERNAL_ERROR', `non-JSON response (HTTP ${res.status})`, { capability: `${name}@${version}`, httpStatus: res.status, retryable: res.status >= 500 }); }
    if (body?.type === 'response') {
      if (body.ok) return body.output;
      throw new AppPortError(body.error?.code ?? 'ERROR', `${body.error?.message ?? 'refused'}${body.error?.details?.reason ? ` [${body.error.details.reason}${body.error.details.problems ? `: ${JSON.stringify(body.error.details.problems).slice(0, 600)}` : ''}]` : ''}`, { capability: `${name}@${version}`, httpStatus: res.status, retryable: body.error?.code === 'CONFLICT', details: body.error?.details });
    }
    // FeltKit's own error shape outside AppPort (e.g. 401 before the binding): { ok:false, error:{code,message} }
    if (body?.error) throw new AppPortError(body.error.code ?? `HTTP_${res.status}`, body.error.message ?? '', { capability: `${name}@${version}`, httpStatus: res.status });
    throw new AppPortError('PROTOCOL', `unexpected reply (HTTP ${res.status})`, { capability: `${name}@${version}`, httpStatus: res.status });
  }

  // ---- the capabilities of the contract -------------------------------------------------------
  pending(limit = 10) { return this.call('runs.pending', 1, { limit }); }
  cancellations() { return this.call('runs.cancellations', 1, {}); }
  courseVersion(courseVersionId) { return this.call('courses.version', 1, { courseVersionId }); }
  admitted(input) { return this.call('runs.admitted', 1, input, { idempotencyKey: `admitted:${input.runId}:${input.workloadId}` }); }
  stage(input) { return this.call('runs.stage', 1, input, { idempotencyKey: `stage:${input.runId}:${input.attemptNumber}:${input.stage}:${input.status}` }); }
  appendEvents(runId, events) { return this.call('runs.events.append', 1, { runId, events }, { idempotencyKey: `events:${runId}:${events[0]?.seq}-${events.at(-1)?.seq}` }); }
  addEvidence(runId, items) { return this.call('runs.evidence.add', 1, { runId, items }, { idempotencyKey: `evidence:${runId}:${items.map((i) => i.evidenceId).join(',').slice(0, 180)}` }); }
  completed(result) { return this.call('runs.completed', 1, result, { idempotencyKey: `completed:${result.runId}` }); }
}
