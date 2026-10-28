/**
 * The course document (course.json): validation and summary.
 *
 * Required top-level sections: identity, objective, environment, capabilities,
 * constraints, obstacles, acceptance, scoring, evidence, cleanup, meta. The inner shape of
 * most sections belongs to the harness and the course author; the app checks what it
 * relies on (identity, meta) and that the document is bounded JSON. Evaluator files
 * (hidden acceptance, reference fixes) are never sent: the seed script reads only
 * course.json files and skips every evaluator/ directory.
 */
import { fail } from "@feltdb/feltkit";
import { byteLength, canonicalJson } from "./canonical.js";

export const COURSE_SECTIONS = [
  "identity",
  "objective",
  "environment",
  "capabilities",
  "constraints",
  "obstacles",
  "acceptance",
  "scoring",
  "evidence",
  "cleanup",
  "meta",
] as const;

export const MAX_COURSE_BYTES = 512 * 1024;
export const COURSE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const COURSE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const KINDS = ["deterministic", "randomized", "adversarial"] as const;
export type CourseKind = (typeof KINDS)[number];

export interface CourseSummary {
  courseId: string;
  version: string;
  name: string;
  description: string;
  kind: CourseKind;
  difficulty: string;
  skills: string[];
  expectedRuntimeSecs?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a course.json document and return its summary. Throws INVALID_ARGUMENT with every problem. */
export function validateCourse(doc: unknown): CourseSummary {
  const problems: string[] = [];
  if (!isObject(doc)) fail("INVALID_ARGUMENT", "A course document must be a JSON object.", { reason: "invalid_course", problems: ["not an object"] });
  let size = 0;
  try {
    size = byteLength(canonicalJson(doc));
  } catch (error) {
    fail("INVALID_ARGUMENT", `The course document is not plain JSON: ${(error as Error).message}`, { reason: "invalid_course" });
  }
  if (size > MAX_COURSE_BYTES) fail("PAYLOAD_TOO_LARGE", `The course document is ${size} bytes; the limit is ${MAX_COURSE_BYTES}.`);
  for (const key of COURSE_SECTIONS) if (!(key in doc)) problems.push(`missing section "${key}"`);
  const identity = doc.identity;
  let courseId = "";
  let version = "";
  let name = "";
  let description = "";
  if (!isObject(identity)) problems.push("identity must be an object { id, version, name, description }");
  else {
    courseId = typeof identity.id === "string" ? identity.id : "";
    version = typeof identity.version === "string" ? identity.version : typeof identity.version === "number" ? String(identity.version) : "";
    name = typeof identity.name === "string" ? identity.name.trim() : "";
    description = typeof identity.description === "string" ? identity.description.trim() : "";
    if (!COURSE_ID.test(courseId)) problems.push("identity.id must be a lowercase slug (a-z, 0-9, . _ -), at most 80 characters");
    if (typeof identity.version !== "string") problems.push("identity.version must be a string (e.g. \"1.0.0\" or \"v1\")");
    else if (!COURSE_VERSION.test(version)) problems.push("identity.version must be 1-40 characters of A-Z a-z 0-9 . _ + -");
    if (!name || name.length > 200) problems.push("identity.name is required (at most 200 characters)");
    if (description.length > 4000) problems.push("identity.description must be at most 4000 characters");
  }
  if (!(typeof doc.objective === "string" ? doc.objective.trim() : isObject(doc.objective))) problems.push("objective must be a non-empty string or an object");
  const meta = doc.meta;
  let kind: CourseKind = "deterministic";
  let difficulty = "";
  let skills: string[] = [];
  let expectedRuntimeSecs: number | undefined;
  if (!isObject(meta)) problems.push("meta must be an object { skills, difficulty, kind, expectedRuntimeSecs, limits }");
  else {
    if (!Array.isArray(meta.skills) || !meta.skills.every((x) => typeof x === "string")) problems.push("meta.skills must be an array of strings");
    else skills = (meta.skills as string[]).slice(0, 50);
    if (typeof meta.difficulty !== "string" && typeof meta.difficulty !== "number") problems.push("meta.difficulty must be a string (or number)");
    else difficulty = String(meta.difficulty);
    if (!KINDS.includes(meta.kind as CourseKind)) problems.push(`meta.kind must be one of ${KINDS.join(", ")}`);
    else kind = meta.kind as CourseKind;
    if (meta.expectedRuntimeSecs !== undefined) {
      if (typeof meta.expectedRuntimeSecs !== "number" || !(meta.expectedRuntimeSecs > 0)) problems.push("meta.expectedRuntimeSecs must be a positive number");
      else expectedRuntimeSecs = meta.expectedRuntimeSecs;
    }
    if (meta.limits !== undefined && !isObject(meta.limits)) problems.push("meta.limits must be an object");
  }
  for (const key of ["environment", "capabilities", "constraints", "obstacles", "acceptance", "scoring", "evidence", "cleanup"] as const) {
    const v = doc[key];
    if (key in doc && !(isObject(v) || Array.isArray(v) || typeof v === "string")) problems.push(`${key} must be an object, an array, or a string`);
  }
  if (problems.length) fail("INVALID_ARGUMENT", `The course document is invalid: ${problems.join("; ")}.`, { reason: "invalid_course", problems });
  return { courseId, version, name, description, kind, difficulty, skills, ...(expectedRuntimeSecs !== undefined ? { expectedRuntimeSecs } : {}) };
}

function short(value: unknown, max = 600): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function names(value: unknown, max = 30): string[] {
  const list = Array.isArray(value) ? value : isObject(value) ? Object.keys(value) : [];
  return list
    .slice(0, max)
    .map((item) => (typeof item === "string" ? item : isObject(item) ? String(item.id ?? item.name ?? item.title ?? short(item, 80)) : String(item)));
}

/** A small, display-only digest of a course document's sections (never the whole spec). */
export interface CourseDisplay {
  objective: string;
  environment: string;
  compatible: string;
  limits: string;
  scoringDimensions: string[];
  acceptanceSummary: string;
  acceptanceChecks: string[];
  obstacles: string[];
  capabilities: string[];
}

export function displayOf(spec: unknown): CourseDisplay {
  const doc = isObject(spec) ? spec : {};
  const meta = isObject(doc.meta) ? doc.meta : {};
  const env = isObject(doc.environment) ? doc.environment : {};
  const scoring = doc.scoring;
  const acceptance = doc.acceptance;
  const objective = isObject(doc.objective) ? (doc.objective.summary ?? doc.objective.goal ?? doc.objective.text ?? doc.objective) : doc.objective;
  const acc = isObject(acceptance) ? acceptance : {};
  return {
    objective: short(objective, 1200),
    environment: short(doc.environment, 600),
    compatible: short(meta.compatible ?? env.compatible ?? env.agents ?? "", 400),
    limits: short(meta.limits ?? "", 400),
    scoringDimensions: names(isObject(scoring) ? (scoring.dimensions ?? scoring) : scoring),
    acceptanceSummary: short(typeof acceptance === "string" ? acceptance : (acc.summary ?? acc.description ?? ""), 800),
    acceptanceChecks: names(acc.checks ?? acc.criteria ?? acc.tests ?? []),
    obstacles: names(isObject(doc.obstacles) ? (doc.obstacles.items ?? doc.obstacles.list ?? doc.obstacles) : doc.obstacles),
    capabilities: names(isObject(doc.capabilities) ? (doc.capabilities.tools ?? doc.capabilities.allowed ?? doc.capabilities) : doc.capabilities),
  };
}
