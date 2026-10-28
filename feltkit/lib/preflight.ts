/**
 * Preflight reports (aoc.preflight.v1): the release gate a course version passes before it can be
 * published. The harness produces them (`npm run courses:preflight`); the app checks their shape,
 * binds them to the exact course document by digest, and refuses to publish without a passing one.
 * A report carries ids, results, counts and digests only (never evaluator source or hidden output).
 */
import { fail } from "@feltdb/feltkit";
import { EVALUATOR_KINDS } from "./acceptance-v1.js";
import { byteLength, canonicalJson, digestOf, normalizeDigest } from "./canonical.js";

export const PREFLIGHT_SCHEMA = "aoc.preflight.v1";
export const MAX_PREFLIGHT_BYTES = 128 * 1024;
/** Every gate a passing report must contain, each with result "pass". */
export const REQUIRED_GATES = [
  "evaluator-resolved",
  "course-valid",
  "fixture-reproducible",
  "baseline-fails",
  "reference-passes",
  "checks-executed",
  "evidence-captured",
  "evaluator-isolated",
  "tamper-detected",
  "cleanup",
] as const;
const GATE_RESULTS = ["pass", "fail", "not-run"];

export interface PreflightSummary {
  courseId: string;
  version: string;
  courseDigest: string;
  evaluatorKind: string;
  evaluatorVersion: string | null;
  evaluatorDigest: string | null;
  acceptanceDigest: string | null;
  result: "pass" | "fail";
  passing: boolean;
  gates: { id: string; result: string }[];
  completedAt: string;
  reportDigest: string;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function refuse(message: string, problems: string[]): never {
  fail("INVALID_ARGUMENT", message, { reason: "invalid_preflight", problems });
}

/** Validate a report's shape and return its summary. A failing report is valid (it is recorded, and never gates a publish). */
export function validatePreflightReport(report: unknown): PreflightSummary {
  const problems: string[] = [];
  if (!isObject(report)) refuse("A preflight report must be a JSON object.", ["not an object"]);
  let size = 0;
  try {
    size = byteLength(canonicalJson(report));
  } catch (error) {
    refuse(`The preflight report is not plain JSON: ${(error as Error).message}`, ["not plain JSON"]);
  }
  if (size > MAX_PREFLIGHT_BYTES) fail("PAYLOAD_TOO_LARGE", `The preflight report is ${size} bytes; the limit is ${MAX_PREFLIGHT_BYTES}.`, { reason: "too_large" });
  if (report.schema !== PREFLIGHT_SCHEMA) problems.push(`schema must be "${PREFLIGHT_SCHEMA}"`);
  const course = isObject(report.course) ? report.course : {};
  const courseDigest = typeof course.digest === "string" ? normalizeDigest(course.digest) : null;
  if (typeof course.id !== "string" || typeof course.version !== "string" || !courseDigest) problems.push("course must be { id, version, digest: sha256:<hex> }");
  const ev = isObject(report.evaluator) ? report.evaluator : {};
  if (!(EVALUATOR_KINDS as readonly string[]).includes(ev.kind)) problems.push(`evaluator.kind must be one of ${EVALUATOR_KINDS.join(", ")}`);
  const evaluatorDigest = typeof ev.digest === "string" ? normalizeDigest(ev.digest) : null;
  if (ev.digest !== undefined && !evaluatorDigest) problems.push("evaluator.digest must be sha256:<hex>");
  const acceptanceDigest = typeof report.acceptanceDigest === "string" ? normalizeDigest(report.acceptanceDigest) : null;
  if (report.acceptanceDigest !== null && report.acceptanceDigest !== undefined && !acceptanceDigest) problems.push("acceptanceDigest must be sha256:<hex> or null");
  if (report.result !== "pass" && report.result !== "fail") problems.push('result must be "pass" or "fail"');
  const gates: { id: string; result: string }[] = [];
  if (!Array.isArray(report.gates) || report.gates.length === 0 || report.gates.length > 50) problems.push("gates must be an array of 1-50 gates");
  else
    for (const [i, g] of report.gates.entries()) {
      if (!isObject(g) || typeof g.id !== "string" || !GATE_RESULTS.includes(g.result)) problems.push(`gates[${i}] must be { id, result: pass|fail|not-run, … }`);
      else gates.push({ id: g.id, result: g.result });
    }
  const completedAt = typeof report.completedAt === "string" ? report.completedAt : "";
  if (!/^\d{4}-\d{2}-\d{2}T/.test(completedAt) || Number.isNaN(Date.parse(completedAt))) problems.push("completedAt must be an ISO-8601 timestamp");
  if (problems.length) refuse(`The preflight report is invalid: ${problems.join("; ")}.`, problems);
  const byId = new Map(gates.map((g) => [g.id, g.result]));
  const passing = report.result === "pass" && gates.every((g) => g.result === "pass") && REQUIRED_GATES.every((g) => byId.get(g) === "pass");
  return {
    courseId: course.id,
    version: course.version,
    courseDigest: courseDigest!,
    evaluatorKind: ev.kind,
    evaluatorVersion: typeof ev.version === "string" ? ev.version.slice(0, 80) : null,
    evaluatorDigest,
    acceptanceDigest,
    result: report.result,
    passing,
    gates,
    completedAt,
    reportDigest: digestOf(report),
  };
}

/** Why a (passing) report does not vouch for this exact course document; empty = it does. */
export function preflightMismatches(summary: Pick<PreflightSummary, "courseId" | "version" | "courseDigest" | "evaluatorKind" | "evaluatorDigest" | "acceptanceDigest">, spec: unknown): string[] {
  const doc = isObject(spec) ? spec : {};
  const problems: string[] = [];
  if (summary.courseDigest !== digestOf(spec)) problems.push(`the report is for course digest ${summary.courseDigest}, this document is ${digestOf(spec)}`);
  if (summary.courseId !== doc.identity?.id || summary.version !== doc.identity?.version) problems.push(`the report is for ${summary.courseId}@${summary.version}`);
  const kind = isObject(doc.evaluator) ? doc.evaluator.kind : undefined;
  if (summary.evaluatorKind !== kind) problems.push(`the report's evaluator kind ${summary.evaluatorKind} is not the document's ${String(kind)}`);
  if (kind === "private" && summary.evaluatorDigest !== normalizeDigest(String(doc.evaluator.digest ?? ""))) problems.push("the report's private evaluator digest is not the one the document pins");
  if (summary.acceptanceDigest !== digestOf(doc.acceptance)) problems.push("the report's acceptance digest is not this document's acceptance");
  return problems;
}
