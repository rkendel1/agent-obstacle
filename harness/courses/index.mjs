// Course library on disk: courses/<courseId>/<version>/{course.json, fixture/?, evaluator/?, reference/?, preflight.json?}.
//
// The PUBLIC course document is course.json. Its digest (sha256 of canonical JSON: recursively
// sorted keys, no whitespace) identifies the course version; the app stores the document verbatim
// and must compute the same digest (import { courseDigest } from this module, or reproduce the rule).
// The document declares its evaluator explicitly (course.evaluator: declarative | private | none)
// and pins the fixture (environment.fixture.digest), a private evaluator directory
// (evaluator.digest) and a declarative course's reference fix (evaluator.reference.digest) by
// digest without revealing their content. Private files (evaluator/, the reference fix) are never
// published to the app and never copied into a workspace. preflight.json is the release-gate
// report (harness/preflight) the seed script publishes with the document.
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COURSES_DIR } from '../lib/paths.mjs';
import { readJSON, writeJSON, canonicalDigest, treeDigest, sha256File } from '../lib/util.mjs';
import { validateCourseAcceptance } from '../../feltkit/lib/acceptance-v1.js';

export const COURSE_SCHEMA = 'aoc.course.v1';
export const REQUIRED_SECTIONS = ['identity', 'objective', 'environment', 'capabilities', 'constraints', 'obstacles', 'evaluator', 'acceptance', 'scoring', 'evidence', 'cleanup', 'meta'];
export const PREFLIGHT_FILE = 'preflight.json';

/** The app's digest form: "sha256:" + hex over canonical JSON of the whole course.json. */
export const courseDigest = (doc) => `sha256:${canonicalDigest(doc)}`;
export const bareDigest = (d) => String(d ?? '').replace(/^sha256:/, '');
export const evaluatorDigest = (courseDir, dir = 'evaluator') => treeDigest(join(courseDir, dir), { exclude: [] }).digest;
export const directoryFixtureDigest = (courseDir, doc) => treeDigest(join(courseDir, doc.environment.fixture.path), { exclude: ['.git', 'target', 'node_modules'] }).digest;

export function listCourses(root = COURSES_DIR) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const id of readdirSync(root).sort()) {
    const cdir = join(root, id);
    if (!statSync(cdir).isDirectory()) continue;
    for (const v of readdirSync(cdir).sort()) {
      const dir = join(cdir, v);
      if (existsSync(join(dir, 'course.json'))) out.push(loadCourseDir(dir));
    }
  }
  return out;
}

export function loadCourseDir(dir) {
  const doc = readJSON(join(dir, 'course.json'));
  return { dir, doc, id: doc.identity?.id, version: doc.identity?.version, digest: courseDigest(doc) };
}

export function loadCourse(courseId, version, root = COURSES_DIR) {
  const dir = join(root, courseId, version);
  if (!existsSync(join(dir, 'course.json'))) throw new Error(`course ${courseId}/${version} not found under ${root}`);
  return loadCourseDir(dir);
}

/** "course-000-calibration/v1" or "course-000-calibration@v1" */
export function loadCourseRef(ref, root = COURSES_DIR) {
  const [id, v] = ref.split(/[/@]/);
  return loadCourse(id, v ?? 'v1', root);
}

export function findCourseByDigest(digest, root = COURSES_DIR) {
  return listCourses(root).find((c) => bareDigest(c.digest) === bareDigest(digest)) ?? null;
}

/** Files of a course version that must never be published or reach a workspace: the private evaluator directory and the reference fix. */
export function privateFiles(course) {
  const { doc, dir } = course;
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  const evDir = join(dir, doc.evaluator?.dir ?? 'evaluator');
  if (doc.evaluator?.kind === 'private' && existsSync(evDir)) walk(evDir);
  const ref = doc.evaluator?.reference?.file;
  if (typeof ref === 'string' && existsSync(join(dir, ref)) && !out.includes(join(dir, ref))) out.push(join(dir, ref));
  return out;
}

/** Private files whose substantive lines appear in `text` (raw or JSON-escaped). */
export function leakedFiles(course, text) {
  const out = [];
  for (const f of privateFiles(course)) {
    if (f.endsWith('PROVENANCE.json')) continue;
    const leaked = readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/^[-+ ]/, '').trim()).filter((l) => l.length >= 30 && !l.startsWith('//') && !l.startsWith('#') && !/^(---|\+\+\+|@@) /.test(l))
      .find((l) => text.includes(l) || text.includes(JSON.stringify(l).slice(1, -1)));
    if (leaked) out.push(f.slice(course.dir.length + 1));
  }
  return out;
}

/** Structural, evaluator and pin validation. Returns a list of problems (empty = valid). */
export function validateCourse(course) {
  const problems = [];
  const { doc, dir } = course;
  if (doc.schema !== COURSE_SCHEMA) problems.push(`schema must be ${COURSE_SCHEMA}`);
  for (const s of REQUIRED_SECTIONS) if (doc[s] === undefined) problems.push(`missing section ${s}`);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(doc.identity?.id ?? '') || typeof doc.identity?.version !== 'string') problems.push('identity.id (lowercase slug) and identity.version (string) are required');
  if (!doc.identity?.name) problems.push('identity.name is required');
  if (!Array.isArray(doc.meta?.skills) || !['deterministic', 'randomized', 'adversarial'].includes(doc.meta?.kind) || doc.meta?.difficulty === undefined) problems.push('meta.skills (string[]), meta.difficulty and meta.kind (deterministic|randomized|adversarial) are required by the app');
  if (typeof doc.objective?.goal !== 'string' || !doc.objective.goal.trim()) problems.push('objective.goal is required');
  else if (Buffer.byteLength(doc.objective.goal) > 2000) problems.push('objective.goal exceeds 2,000 bytes (Stack-Agent goal limit)');
  if (!['directory', 'git'].includes(doc.environment?.fixture?.type)) problems.push('environment.fixture.type must be directory|git');
  problems.push(...validateCourseAcceptance(doc));
  const ev = doc.evaluator ?? {};
  if (ev.kind === 'none') problems.push('evaluator.kind is "none": every run of this course ends ERROR (evaluator-missing)');
  if (ev.kind === 'private') {
    const evDir = join(dir, ev.dir ?? 'evaluator');
    if (!existsSync(evDir)) problems.push(`private evaluator directory ${ev.dir ?? 'evaluator'}/ missing`);
    else if (ev.digest !== evaluatorDigest(dir, ev.dir ?? 'evaluator')) problems.push(`evaluator.digest is not pinned to the private evaluator files (expected ${evaluatorDigest(dir, ev.dir ?? 'evaluator')}); run npm run courses:pin`);
    for (const h of doc.acceptance?.hidden ?? []) if (typeof h?.file === 'string' && !existsSync(join(dir, h.file))) problems.push(`hidden acceptance file ${h.file} missing`);
  }
  if (ev.kind === 'declarative' && existsSync(join(dir, 'evaluator'))) problems.push('a declarative course has no evaluator/ directory (move private material out, or declare evaluator.kind "private")');
  const ref = ev.reference?.file;
  if (typeof ref === 'string') {
    if (!existsSync(join(dir, ref))) problems.push(`reference file ${ref} missing`);
    else if (ev.kind === 'declarative' && ev.reference.digest !== sha256File(join(dir, ref))) problems.push(`evaluator.reference.digest is not pinned (expected ${sha256File(join(dir, ref))}); run npm run courses:pin`);
  }
  if (doc.environment?.fixture?.type === 'directory') {
    const fd = directoryFixtureDigest(dir, doc);
    if (doc.environment.fixture.digest !== fd) problems.push(`environment.fixture.digest is not pinned (expected ${fd}); run npm run courses:pin`);
  } else if (doc.environment?.fixture?.type === 'git' && !/^[0-9a-f]{64}$/.test(doc.environment.fixture.digest ?? '')) {
    problems.push('environment.fixture.digest must be pinned after a first prepare (npm run courses:pin -- --prepare)');
  }
  for (const c of doc.constraints ?? []) if (!['enforced', 'detected', 'partially-detected', 'not-enforced'].includes(c.enforcement)) problems.push(`constraint ${c.id}: enforcement must be enforced|detected|partially-detected|not-enforced`);
  // Nothing private may leak into the public document.
  for (const f of leakedFiles(course, JSON.stringify(doc))) problems.push(`course document contains private evaluator content from ${f}`);
  return problems;
}

/** Write the pinned digests into course.json. For git fixtures, `fixtureDigest` comes from a prepare. */
export function pinCourse(course, { fixtureDigest } = {}) {
  const doc = course.doc;
  if (doc.evaluator?.kind === 'private' && existsSync(join(course.dir, doc.evaluator.dir ?? 'evaluator'))) doc.evaluator.digest = evaluatorDigest(course.dir, doc.evaluator.dir ?? 'evaluator');
  if (doc.evaluator?.kind === 'declarative' && doc.evaluator.reference?.file) doc.evaluator.reference.digest = sha256File(join(course.dir, doc.evaluator.reference.file));
  if (doc.environment.fixture.type === 'directory') doc.environment.fixture.digest = directoryFixtureDigest(course.dir, doc);
  else if (fixtureDigest) doc.environment.fixture.digest = fixtureDigest;
  writeJSON(join(course.dir, 'course.json'), doc);
  return loadCourseDir(course.dir);
}

/** The document published to the app (course.json as-is; private files are not part of it). */
export const publicDocument = (course) => course.doc;

/** The course's preflight report (preflight.json next to course.json), or null. */
export const readPreflight = (course) => readJSON(join(course.dir, PREFLIGHT_FILE), null);
