/**
 * Canonical JSON and digests.
 *
 * canonicalJson(value): JSON with object keys sorted by code unit order (Array.prototype.sort
 * default), no insignificant whitespace, arrays in order, strings and numbers exactly as
 * JSON.stringify writes them, `undefined` object members omitted. For the JSON documents
 * this app handles (integers, ordinary decimals, strings, booleans, null) this is the
 * RFC 8785 (JCS) form. Non-finite numbers are refused.
 *
 * digest(value) = "sha256:" + hex(sha256(utf8(canonicalJson(value)))).
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      const entries = Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** "sha256:<hex>" of the canonical JSON. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Accept "sha256:<hex>" or a bare 64-hex digest; normalize to "sha256:<hex>". */
export function normalizeDigest(digest: string): string | null {
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(digest.trim());
  return m ? `sha256:${m[1]!.toLowerCase()}` : null;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
