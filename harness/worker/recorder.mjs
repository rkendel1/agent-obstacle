// Per-run event log + evidence store, and the sinks they flush to.
//
// Events are numbered per run and persisted (events.jsonl in the run directory) BEFORE they are
// sent, so a restarted worker continues the same sequence; the app de-duplicates on (runId, seq),
// so resending is always safe.
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readJSONL, appendJSONL, writeJSON, bounded, nowIso, canonicalJSON } from '../lib/util.mjs';
import { EvidenceStore } from '../evidence/index.mjs';

const SOURCES = new Set(['agent', 'runtime', 'pax', 'evaluator', 'harness']);

export class EventLog {
  constructor(runDir) {
    this.path = join(runDir, 'events.jsonl');
    const existing = readJSONL(this.path);
    this.events = existing;
    this.seq = existing.reduce((m, e) => Math.max(m, e.seq), 0);
    this.sent = 0;
  }
  append({ source = 'harness', kind, summary, data }) {
    if (!SOURCES.has(source)) source = 'harness';
    const e = { seq: ++this.seq, at: nowIso(), source, kind, summary: bounded(String(summary ?? '').split('\n')[0], 500) };
    if (data !== undefined) {
      const d = JSON.stringify(data);
      e.data = d.length > 16 * 1024 ? { truncated: true, bytes: d.length } : data;
    }
    appendJSONL(this.path, e);
    this.events.push(e);
    return e;
  }
  pending() { return this.events.filter((e) => e.seq > this.sent); }
  acknowledge(upTo) { this.sent = Math.max(this.sent, upTo); }
  has(pred) { return this.events.some(pred); }
}

export class Recorder {
  constructor(runId, runDir, sink, log = () => {}) {
    this.runId = runId; this.runDir = runDir; this.sink = sink; this.log = log;
    mkdirSync(runDir, { recursive: true });
    this.events = new EventLog(runDir);
    this.evidence = new EvidenceStore(runDir);
  }
  emit(e) { const ev = this.events.append(e); this.log(`[${this.runId}] ${ev.source}/${ev.kind}: ${ev.summary}`); return ev; }
  addEvidence(item) { return this.evidence.add(item); }

  /** Push pending events and evidence to the sink. Failures are retried on the next flush. */
  async flush() {
    if (!this.sink) return;
    try {
      let pending = this.events.pending();
      while (pending.length) {
        const batch = pending.slice(0, 200);
        await this.sink.appendEvents(this.runId, batch);
        this.events.acknowledge(batch.at(-1).seq);
        pending = pending.slice(200);
      }
      const items = this.evidence.pending();
      // one call per ~512 KiB of inline content
      let batch = [], size = 0;
      const send = async () => { if (!batch.length) return; await this.sink.addEvidence(this.runId, batch); this.evidence.acknowledge(batch.map((i) => i.evidenceId)); batch = []; size = 0; };
      for (const it of items) {
        const s = Buffer.byteLength(it.content ?? '');
        if (size + s > 512 * 1024) await send();
        batch.push(it); size += s;
      }
      await send();
    } catch (e) {
      this.log(`[${this.runId}] flush to the app failed (will retry): ${e.message}`);
      return false;
    }
    return true;
  }
}

/** Sink over the app (AppClient, or FakeApp in unit tests): the contract's capabilities. */
export class AppSink {
  constructor(app) { this.app = app; }
  stage(i) { return this.app.stage(i); }
  appendEvents(runId, events) { return this.app.appendEvents(runId, events); }
  addEvidence(runId, items) { return this.app.addEvidence(runId, items); }
  completed(result) { return this.app.completed(result); }
  courseVersion(id) { return this.app.courseVersion(id); }
}

/** Local sink (harness:run without the app): writes what the app would receive into the run dir. */
export class FileSink {
  constructor(runDir) { this.runDir = runDir; mkdirSync(runDir, { recursive: true }); }
  async stage(i) { appendJSONL(join(this.runDir, 'app-stages.jsonl'), i); return { ok: true }; }
  async appendEvents() { return { appended: 0 }; }        // events.jsonl already is the record
  async addEvidence() { return { added: 0 }; }            // evidence.jsonl + artifacts/ already are the record
  async completed(result) {
    const prev = readJSONL(join(this.runDir, 'app-result.jsonl')).at(-1);
    if (prev && canonicalJSON(prev) !== canonicalJSON(result)) throw new Error('a different result is already recorded');
    if (!prev) appendFileSync(join(this.runDir, 'app-result.jsonl'), JSON.stringify(result) + '\n');
    writeJSON(join(this.runDir, 'run-result.json'), result);
    return { ok: true };
  }
}
