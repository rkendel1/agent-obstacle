// Evidence capture: PAX observations, the workspace diff, digests, process facts.
// Rule: an unsupported or failed PAX observation is recorded exactly as PAX reported it
// (`unsupported` stays `unsupported`); nothing is converted, estimated or filled in.
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { sha256, bounded, appendJSONL, readJSONL } from '../lib/util.mjs';

export const PAX_OBSERVATIONS = ['info', 'doctor', 'reality', 'drift'];
export const EXCLUDE_PATHSPEC = [':(exclude).stack-agent', ':(exclude).stack-agent/**'];

/** Run `pax --dir <dir> --json <op>` for each observation (not `test`). */
export function paxObserve(dir, { env, ops = PAX_OBSERVATIONS, timeoutMs = 120_000 } = {}) {
  const out = {};
  for (const op of ops) {
    const r = run(TOOLS.pax, ['--dir', dir, '--json', op], { cwd: dir, env, timeoutMs });
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { /* not JSON */ }
    out[op] = {
      op, exit: r.code, signal: r.signal ?? null, ms: r.durationMs,
      // PAX's own words: outcome/status/reason as reported, or "unparsed" if stdout was not JSON.
      status: doc ? (doc.status ?? doc.outcome ?? null) : 'unparsed',
      reason: doc?.reason ?? null,
      schema: doc?.schema ?? null,
      raw: doc ?? bounded(r.stdout, 16 * 1024),
      stderrTail: bounded(r.stderr, 4 * 1024),
    };
  }
  return out;
}

/** Real PAX `test` (evaluator-side observation; not the agent's). */
export function paxTest(dir, { env, timeoutMs = 900_000 } = {}) {
  const r = run(TOOLS.pax, ['--dir', dir, '--json', 'test'], { cwd: dir, env, timeoutMs });
  let doc = null; try { doc = JSON.parse(r.stdout); } catch {}
  return { exit: r.code, status: doc?.status ?? 'unparsed', reason: doc?.reason ?? null, tool: doc?.tool ?? null, tests: doc?.tests ?? null, ms: r.durationMs };
}

/**
 * The agent's work product against the base commit: tracked changes, committed changes and new
 * untracked (non-ignored) files, excluding `.stack-agent/`. Uses a temporary index so the
 * workspace's own index is untouched. Returns { diff, files: [{status, path}], digest }.
 */
export function workspaceDiff(workspace, baseCommit, { tmpDir }) {
  mkdirSync(tmpDir, { recursive: true });
  const index = join(tmpDir, `index-${process.pid}-${Date.now()}`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
  try {
    const add = run('git', ['add', '-A'], { cwd: workspace, env });
    if (add.code !== 0) throw new Error(`git add (temporary index) failed: ${add.stderr.slice(-400)}`);
    // .stack-agent/ is excluded even if the agent removed the exclude rule.
    run('git', ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.stack-agent'], { cwd: workspace, env });
    const diff = run('git', ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', baseCommit, '--', '.', ...EXCLUDE_PATHSPEC], { cwd: workspace, env });
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.slice(-400)}`);
    const names = run('git', ['diff', '--cached', '--name-status', '--no-renames', baseCommit, '--', '.', ...EXCLUDE_PATHSPEC], { cwd: workspace, env });
    const files = names.stdout.split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
    return { diff: diff.stdout, files, digest: sha256(diff.stdout) };
  } finally { rmSync(index, { force: true }); }
}

/** `git status --short` excluding .stack-agent/ (for the record). */
export function workspaceStatus(workspace) {
  return run('git', ['status', '--short', '--untracked-files=all', '--', '.', ...EXCLUDE_PATHSPEC], { cwd: workspace, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0' } }).stdout;
}

/**
 * Evidence store for one run: files under <runDir>/artifacts/, an index (evidence.jsonl), and
 * EvidenceItems shaped for runs.evidence.add (content inline when ≤ 256 KiB, else path + digest).
 */
export class EvidenceStore {
  constructor(runDir) {
    this.dir = join(runDir, 'artifacts');
    this.index = join(runDir, 'evidence.jsonl');
    mkdirSync(this.dir, { recursive: true });
    this.items = new Map(readJSONL(this.index).map((i) => [i.evidenceId, i]));
    this.unsent = new Set();
  }
  /** @returns the EvidenceItem */
  add({ evidenceId, kind, label, source, content, file }) {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const name = file ?? `${evidenceId.replace(/[^a-zA-Z0-9._-]+/g, '_')}.${typeof content === 'string' ? 'txt' : 'json'}`;
    writeFileSync(join(this.dir, name), text);
    const digest = sha256(text);
    const inline = Buffer.byteLength(text) <= 256 * 1024;
    const item = { evidenceId, kind, label, source, digest, ...(inline ? { content: text } : {}), path: `artifacts/${name}` };
    const prev = this.items.get(evidenceId);
    if (!prev || prev.digest !== digest) {
      this.items.set(evidenceId, item);
      appendJSONL(this.index, { ...item, content: undefined });
    }
    this.unsent.add(evidenceId);
    return item;
  }
  has(evidenceId) { return this.items.has(evidenceId) && existsSync(join(this.dir, '..', this.items.get(evidenceId).path)); }
  /** Items not yet acknowledged by the sink (content re-read from disk for items loaded from the index). */
  pending() { return [...this.unsent].map((id) => this.items.get(id)).filter(Boolean); }
  acknowledge(ids) { for (const id of ids) this.unsent.delete(id); }
  index_() { return [...this.items.values()].map(({ content, ...rest }) => rest); }
}
