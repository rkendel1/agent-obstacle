// The acceptance.v1 interpreter. Trusted harness code: it executes only what the shared schema
// (feltkit/lib/acceptance-v1.js) admits — approved argv with bounded timeouts, reads confined to
// the evaluation tree, explicit all/any. It re-validates the spec before running anything: an
// unknown kind or field is an evaluator error, never a silent pass.
//
// Every check record says whether it EXECUTED. Aggregation never turns an unexecuted or errored
// check into a pass: all = every child pass; any = at least one child pass; otherwise fail when a
// child decisively failed, else error.
import { readFileSync, lstatSync, realpathSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { runGroup } from '../lib/proc.mjs';
import { sha256, tail, canonicalJSON } from '../lib/util.mjs';
import { validateAcceptanceV1 } from '../../feltkit/lib/acceptance-v1.js';
import { gitHead, gitRefs } from '../courses/fixtures.mjs';
import { parseTestOutput } from './parse.mjs';

const MAX_READ = 1024 * 1024;
const OUT_KEEP = 1024 * 1024;

/** Resolve a validated relative path inside `root`; refuses symlinks that leave it. */
export function confined(root, rel) {
  const p = join(root, rel);
  let st;
  try { st = lstatSync(p); } catch { return { path: p, exists: false }; }
  const realRoot = realpathSync(root);
  let real;
  try { real = realpathSync(p); } catch { return { path: p, exists: true, dangling: true, symlink: st.isSymbolicLink() }; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { path: p, exists: true, escape: true };
  return { path: p, exists: true, real, symlink: st.isSymbolicLink(), dir: lstatSync(real).isDirectory() };
}

function readBounded(path) {
  const buf = readFileSync(path);
  if (buf.length > MAX_READ) return { tooLarge: true, bytes: buf.length };
  return { text: buf.toString('utf8') };
}

/** RFC 6901. */
export function jsonPointer(doc, ptr) {
  if (ptr === '') return { found: true, value: doc };
  let cur = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, Array.isArray(cur) ? Number(k) : k) || (Array.isArray(cur) && !/^(0|[1-9]\d*)$/.test(k))) return { found: false };
    cur = cur[Array.isArray(cur) ? Number(k) : k];
  }
  return { found: true, value: cur };
}

/** Evaluate a validated `match` against text: { ok, detail }. */
export function matchText(m, s) {
  if (m.exact !== undefined) return { ok: s === m.exact, detail: s === m.exact ? 'exact match' : `not equal (${s.length} chars)` };
  if (m.contains !== undefined) return { ok: s.includes(m.contains), detail: s.includes(m.contains) ? 'contains the text' : 'does not contain the text' };
  if (m.regex !== undefined) { const ok = new RegExp(m.regex, m.flags ?? '').test(s.slice(0, MAX_READ)); return { ok, detail: ok ? 'regex matched' : 'regex did not match' }; }
  let doc;
  try { doc = JSON.parse(s); } catch { return { ok: false, detail: 'not JSON' }; }
  const r = jsonPointer(doc, m.jsonPointer);
  if (!r.found) return { ok: false, detail: `no value at ${m.jsonPointer || '(root)'}` };
  const ok = canonicalJSON(r.value) === canonicalJSON(m.equals);
  return { ok, detail: ok ? `${m.jsonPointer || '(root)'} equals the expected value` : `${m.jsonPointer || '(root)'} is ${tail(JSON.stringify(r.value), 120)}` };
}

const exitOk = (spec, code) => (spec.equals !== undefined ? code === spec.equals : spec.notEquals !== undefined ? code !== spec.notEquals : spec.in.includes(code));
const exitText = (spec) => (spec.equals !== undefined ? `= ${spec.equals}` : spec.notEquals !== undefined ? `≠ ${spec.notEquals}` : `∈ [${spec.in.join(', ')}]`);
const boundOk = (b, n) => (b.equals === undefined || n === b.equals) && (b.min === undefined || n >= b.min) && (b.max === undefined || n <= b.max);

function fileId(root, rel) {
  const c = confined(root, rel);
  if (!c.exists) return { exists: false };
  const st = lstatSync(c.path);
  if (st.isSymbolicLink()) return { exists: true, link: readlinkSync(c.path) };
  if (st.isDirectory()) return { exists: true, dir: true };
  return { exists: true, sha256: sha256(readFileSync(c.path)) };
}

/**
 * Run an acceptance.v1 spec in `tree` (the fresh evaluation tree).
 * @returns {Promise<{ result, error?, failureClass?, records: object[], root: object|null, setup: object[], steps: object[] }>}
 *   records: one per check node (document order) { id, kind, result, executed, detail, observed? }
 */
export async function runDeclarative({ spec, ecosystem, tree, fixture, workspace, env, outDir, hidden = false }) {
  const problems = validateAcceptanceV1(spec, { ecosystem });
  if (problems.length) return { result: 'error', failureClass: 'evaluator', error: `acceptance.v1 is invalid: ${problems.slice(0, 8).join('; ')}`, records: [], root: null, setup: [], steps: [] };
  const steps = [];
  const exec = async (name, argv, timeoutSecs, cwd) => {
    const r = await runGroup(argv[0], argv.slice(1), { cwd: cwd ? join(tree, cwd) : tree, env, timeoutMs: timeoutSecs * 1000 });
    const log = `$ ${argv.join(' ')}\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.timedOut ? ' (timed out)' : ''} in ${r.durationMs} ms\n`;
    writeFileSync(join(outDir, `${name}.log`), log);
    const step = { name, argv, exit: r.code, signal: r.signal ?? null, timedOut: r.timedOut, ms: r.durationMs, spawnError: r.error ?? null, logDigest: sha256(log) };
    steps.push(step);
    return { ...step, stdout: r.stdout.slice(-OUT_KEEP), stderr: r.stderr.slice(-OUT_KEEP) };
  };

  // setup: environment, not the agent; a failure is an evaluator-side error (ERROR, environment)
  const setup = [];
  for (const s of spec.setup ?? []) {
    const r = await exec(`setup-${s.id}`, s.argv, s.timeoutSecs, s.cwd);
    setup.push({ id: s.id, exit: r.exit, timedOut: r.timedOut, ms: r.ms });
    if (r.exit !== 0 || r.spawnError) return { result: 'error', failureClass: 'environment', error: `setup ${s.id} failed (exit ${r.exit}${r.timedOut ? ', timed out' : ''})`, records: [], root: null, setup, steps };
  }

  const ran = new Map();     // id -> captured output of command/test checks
  const records = [];

  async function leaf(c) {
    const rec = { id: c.id, kind: c.kind, result: 'not-run', executed: false };
    try {
      switch (c.kind) {
        case 'command': case 'test': {
          const r = await exec(`check-${c.id.replace(/[^a-z0-9._-]+/g, '_')}`, c.argv, c.timeoutSecs, c.cwd);
          rec.executed = true;
          rec.observed = { exit: r.exit, signal: r.signal, timedOut: r.timedOut, ms: r.ms, logDigest: r.logDigest };
          if (r.spawnError || (r.exit === null && !r.timedOut)) { rec.result = 'error'; rec.executed = false; rec.detail = `could not run ${c.argv[0]}: ${r.spawnError ?? r.signal}`; break; }
          ran.set(c.id, r);
          if (r.timedOut) { rec.result = 'fail'; rec.detail = `timed out after ${c.timeoutSecs}s`; break; }
          const exitPass = exitOk(c.exit, r.exit);
          rec.detail = `exit ${r.exit} (expected ${exitText(c.exit)})`;
          if (c.kind === 'test') {
            const parsed = c.format === 'none' ? null : parseTestOutput(`${r.stdout}\n${r.stderr}`);
            const counts = parsed && parsed.passed !== null ? { passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped } : null;
            rec.observed.counts = counts;
            if (!hidden) { rec.observed.failing = parsed?.failing?.slice(0, 20) ?? []; rec.observed.tail = tail(`${r.stdout}\n${r.stderr}`, 1500); }
            if (counts) rec.detail += `; passed ${counts.passed}, failed ${counts.failed}, skipped ${counts.skipped}`;
            if (!exitPass) { rec.result = 'fail'; break; }
            if (c.counts) {
              if (!counts) { rec.result = 'error'; rec.detail += `; the harness could not read ${c.format} test counts, so the count bounds were not checked`; break; }
              const bad = Object.entries(c.counts).filter(([k, b]) => !boundOk(b, counts[k]));
              if (bad.length) { rec.result = 'fail'; rec.detail += `; counts out of bounds: ${bad.map(([k, b]) => `${k} ${counts[k]} vs ${JSON.stringify(b)}`).join(', ')}`; break; }
            }
            rec.result = 'pass';
          } else {
            if (!hidden) rec.observed.tail = tail(`${r.stdout}\n${r.stderr}`, 1500);
            rec.result = exitPass ? 'pass' : 'fail';
          }
          break;
        }
        case 'output': {
          const src = ran.get(c.of);
          if (!src) { rec.detail = `${c.of} did not run`; break; }
          if (src.timedOut) { rec.detail = `${c.of} timed out; its output is incomplete`; break; }
          const s = c.stream === 'both' ? `${src.stdout}\n${src.stderr}` : src[c.stream];
          const m = matchText(c.match, s);
          rec.executed = true; rec.result = m.ok ? 'pass' : 'fail'; rec.detail = `${c.of} ${c.stream}: ${m.detail}`;
          break;
        }
        case 'files-exist': {
          const missing = []; const escaped = [];
          for (const p of c.paths) { const f = confined(tree, p); if (!f.exists || f.dangling) missing.push(p); else if (f.escape) escaped.push(p); }
          rec.executed = true; rec.result = missing.length || escaped.length ? 'fail' : 'pass';
          rec.detail = [missing.length ? `missing: ${missing.join(', ')}` : '', escaped.length ? `outside the evaluation tree (symlink): ${escaped.join(', ')}` : ''].filter(Boolean).join('; ') || `${c.paths.length} present`;
          break;
        }
        case 'file-content': {
          const f = confined(tree, c.path);
          rec.executed = true;
          if (!f.exists || f.dangling) { rec.result = 'fail'; rec.detail = `${c.path} is missing`; break; }
          if (f.escape) { rec.result = 'fail'; rec.detail = `${c.path} leaves the evaluation tree (symlink); not read`; break; }
          if (f.dir) { rec.result = 'fail'; rec.detail = `${c.path} is a directory`; break; }
          const r = readBounded(f.real);
          if (r.tooLarge) { rec.result = 'fail'; rec.detail = `${c.path} is ${r.bytes} bytes; at most ${MAX_READ} are read`; break; }
          const m = matchText(c.match, r.text);
          rec.result = m.ok ? 'pass' : 'fail'; rec.detail = `${c.path}: ${m.detail}`;
          break;
        }
        case 'invariant': {
          rec.executed = true;
          if (c.invariant === 'no-commits') {
            const head = gitHead(workspace); const refs = gitRefs(workspace);
            const ok = head === fixture.baseCommit && refs === fixture.refs;
            rec.result = ok ? 'pass' : 'fail'; rec.detail = ok ? `HEAD and refs at the base ${fixture.baseCommit.slice(0, 12)}` : `HEAD ${head.slice(0, 12)} / refs differ from the base`;
          } else if (c.invariant === 'absent') {
            const present = c.paths.filter((p) => confined(tree, p).exists);
            rec.result = present.length ? 'fail' : 'pass'; rec.detail = present.length ? `present: ${present.join(', ')}` : 'absent';
          } else {
            const changed = c.paths.filter((p) => canonicalJSON(fileId(tree, p)) !== canonicalJSON(fileId(fixture.tree, p)));
            rec.result = changed.length ? 'fail' : 'pass'; rec.detail = changed.length ? `changed vs the fixture: ${changed.join(', ')}` : `${c.paths.length} path(s) identical to the fixture`;
          }
          break;
        }
        default:
          rec.result = 'error'; rec.detail = `unknown check kind ${c.kind}`;
      }
    } catch (e) { rec.result = 'error'; rec.executed = false; rec.detail = `evaluator error: ${e.message}`; }
    return rec;
  }

  async function node(c) {
    if (c.kind !== 'all' && c.kind !== 'any') { const r = await leaf(c); records.push(r); return r; }
    const rec = { id: c.id, kind: c.kind, result: 'not-run', executed: false };
    records.push(rec);
    const kids = [];
    for (const k of c.of) kids.push(await node(k));          // no short-circuit: every check runs and is recorded
    const pass = kids.filter((k) => k.result === 'pass').length;
    const fail = kids.filter((k) => k.result === 'fail').length;
    rec.executed = kids.every((k) => k.executed);
    if (c.kind === 'all') rec.result = pass === kids.length ? 'pass' : fail ? 'fail' : 'error';
    else rec.result = pass ? 'pass' : kids.some((k) => k.result === 'error' || k.result === 'not-run') ? 'error' : 'fail';
    rec.detail = `${c.kind}: ${pass}/${kids.length} pass${fail ? `, ${fail} fail` : ''}${kids.length - pass - fail ? `, ${kids.length - pass - fail} error/not-run` : ''}`;
    return rec;
  }

  const root = await node(spec.require);
  const out = { result: root.result, records, root, setup, steps };
  if (root.result === 'error') { out.failureClass = 'evaluator'; out.error = `acceptance could not be decided: ${records.filter((r) => r.result === 'error' || r.result === 'not-run').map((r) => `${r.id} (${r.detail ?? r.result})`).slice(0, 6).join('; ')}`; }
  return out;
}

