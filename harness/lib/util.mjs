// Small shared helpers for the harness: hashing, canonical JSON, files, time.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, readlinkSync, renameSync, appendFileSync, chmodSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const sha256File = (path) => sha256(readFileSync(path));
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** JSON with recursively sorted object keys and no whitespace (the digest form). */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}
export const canonicalDigest = (value) => sha256(canonicalJSON(value));

export function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

/** Atomic JSON write (temp + rename). mode 0o600 for anything holding secrets. */
export function writeJSON(path, value, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function appendJSONL(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n');
}

export function readJSONL(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export const DEFAULT_TREE_EXCLUDES = ['.git', 'node_modules', 'target', '.stack-agent'];

/**
 * Digest of a directory tree: sorted relative paths with the sha256 of each file (or symlink
 * target). Directories named in `exclude` are skipped at any depth.
 */
export function treeDigest(root, { exclude = DEFAULT_TREE_EXCLUDES } = {}) {
  const lines = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (exclude.includes(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join('/');
      if (st.isSymbolicLink()) lines.push(`${rel}\0l\0${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) lines.push(`${rel}\0f\0${sha256File(p)}`);
    }
  };
  walk(root);
  return { digest: sha256(lines.join('\n')), files: lines.length };
}

/** Truncate text to `max` bytes (UTF-8), marking the cut. */
export function bounded(text, max = 256 * 1024) {
  const s = String(text ?? '');
  const buf = Buffer.from(s);
  if (buf.length <= max) return s;
  return buf.subarray(0, max - 64).toString('utf8') + `\n…[truncated ${buf.length - max + 64} bytes]`;
}

export const tail = (text, max = 4000) => { const s = String(text ?? ''); return s.length <= max ? s : '…' + s.slice(-max); };

export function errorInfo(e) {
  if (!e) return { message: 'unknown error' };
  return { message: String(e.message ?? e), ...(e.code ? { code: e.code } : {}), ...(e.status ? { status: e.status } : {}) };
}

export const ensureDir = (p) => { mkdirSync(p, { recursive: true }); return p; };
