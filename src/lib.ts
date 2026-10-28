import { useEffect, useState } from "react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

/** Same matching rule as AppPort: exact, "ns.*", or "*". A UI hint only; the server decides. */
export function can(granted: readonly string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

export function describeError(error: unknown): string {
  const e = error as FeltKitClientError & { details?: { problems?: string[] } };
  if (e?.code === "FORBIDDEN") return `Not allowed for your role: ${e.message}`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  if (e?.details && Array.isArray(e.details.problems) && e.details.problems.length) return `${e.message}`;
  return e?.message ?? String(error);
}

export interface Route {
  name: "library" | "course" | "configure" | "run" | "history" | "compare" | "builder";
  id?: string;
  params: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [head, id] = path.split("/");
  const params = new URLSearchParams(query);
  switch (head) {
    case "course":
      return { name: "course", id: id ? decodeURIComponent(id) : undefined, params };
    case "configure":
      return { name: "configure", params };
    case "runs":
      return id ? { name: "run", id: decodeURIComponent(id), params } : { name: "history", params };
    case "history":
      return { name: "history", params };
    case "compare":
      return { name: "compare", params };
    case "builder":
      return { name: "builder", params };
    default:
      return { name: "library", params };
  }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}

export function href(path: string, params?: Record<string, string | undefined | null>): string {
  const q = params ? new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString() : "";
  return `#/${path}${q ? `?${q}` : ""}`;
}

export function go(path: string, params?: Record<string, string | undefined | null>): void {
  window.location.hash = href(path, params).slice(1);
}

export function fmtTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "not observed";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m} min ${rest} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not observed";
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not observed";
  return `${(n * 100).toFixed(0)}%`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function shortDigest(d: string | null | undefined): string {
  if (!d) return "—";
  const hex = d.replace(/^sha256:/, "");
  return `sha256:${hex.slice(0, 12)}…`;
}

export function pretty(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
