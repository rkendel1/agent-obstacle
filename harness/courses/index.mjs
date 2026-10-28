// Course library on disk: courses/<courseId>/<version>/{course.json, fixture/?, evaluator/}.
//
// The PUBLIC course document is course.json. Its digest (sha256 of canonical JSON: recursively
// sorted keys, no whitespace) identifies the course version; the app stores the document verbatim
// and must compute the same digest (import { courseDigest } from this module, or reproduce the rule).
// The document pins the fixture (environment.fixture.digest) and the evaluator files
// (acceptance.evaluatorDigest) by digest without revealing evaluator content. Files under
// evaluator/ are never published to the app and never copied into a workspace.
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COURSES_DIR } from '../lib/paths.mjs';
import { readJSON, writeJSON, canonicalDigest, treeDigest } from '../lib/util.mjs';

export const COURSE_SCHEMA = 'aoc.course.v1';
export const REQUIRED_SECTIONS = ['identity', 'objective', 'environment', 'capabilities', 'constraints', 'obstacles', 'acceptance', 'scoring', 'evidence', 'cleanup', 'meta'];

export const courseDigest = (doc) => canonicalDigest(doc);
export const evaluatorDigest = (courseDir) => treeDigest(join(courseDir, 'evaluator'), { exclude: [] }).digest;
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
  return { dir, doc, id: doc.identity?.courseId, version: doc.identity?.version, digest: courseDigest(doc), evaluatorDir: join(dir, 'evaluator') };
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
  return listCourses(root).find((c) => c.digest === digest) ?? null;
}

/** Structural and pin validation. Returns a list of problems (empty = valid). */
export function validateCourse(course) {
  const problems = [];
  const { doc, dir } = course;
  if (doc.schema !== COURSE_SCHEMA) problems.push(`schema must be ${COURSE_SCHEMA}`);
  for (const s of REQUIRED_SECTIONS) if (doc[s] === undefined) problems.push(`missing section ${s}`);
  if (!doc.identity?.courseId || !doc.identity?.version) problems.push('identity.courseId and identity.version are required');
  if (typeof doc.objective?.goal !== 'string' || !doc.objective.goal.trim()) problems.push('objective.goal is required');
  else if (Buffer.byteLength(doc.objective.goal) > 2000) problems.push('objective.goal exceeds 2,000 bytes (Stack-Agent goal limit)');
  if (!['directory', 'git'].includes(doc.environment?.fixture?.type)) problems.push('environment.fixture.type must be directory|git');
  const ev = existsSync(join(dir, 'evaluator')) ? evaluatorDigest(dir) : null;
  if (!ev) problems.push('evaluator/ directory missing');
  else if (doc.acceptance?.evaluatorDigest !== ev) problems.push(`acceptance.evaluatorDigest is not pinned to the evaluator files (expected ${ev}); run npm run courses:pin`);
  if (doc.environment?.fixture?.type === 'directory') {
    const fd = directoryFixtureDigest(dir, doc);
    if (doc.environment.fixture.digest !== fd) problems.push(`environment.fixture.digest is not pinned (expected ${fd}); run npm run courses:pin`);
  } else if (doc.environment?.fixture?.type === 'git' && !/^[0-9a-f]{64}$/.test(doc.environment.fixture.digest ?? '')) {
    problems.push('environment.fixture.digest must be pinned after a first prepare (npm run courses:pin -- --prepare)');
  }
  for (const h of doc.acceptance?.hidden ?? []) {
    if (!h.file?.startsWith('evaluator/')) problems.push(`hidden acceptance file ${h.file} must live under evaluator/`);
    else if (!existsSync(join(dir, h.file))) problems.push(`hidden acceptance file ${h.file} missing`);
  }
  if (doc.acceptance?.reference?.file && !existsSync(join(dir, doc.acceptance.reference.file))) problems.push('reference file missing');
  for (const c of doc.constraints ?? []) if (!['enforced', 'detected', 'partially-detected', 'not-enforced'].includes(c.enforcement)) problems.push(`constraint ${c.id}: enforcement must be enforced|detected|partially-detected|not-enforced`);
  // Nothing evaluator-only may leak into the public document.
  const text = JSON.stringify(doc);
  for (const f of evaluatorFiles(dir)) {
    const leaked = readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.length >= 30 && !l.startsWith('//') && !l.startsWith('#'))
      .find((l) => text.includes(JSON.stringify(l).slice(1, -1)));
    if (leaked) problems.push(`course document contains evaluator content from ${f.slice(dir.length + 1)}`);
  }
  return problems;
}

function evaluatorFiles(dir) {
  const root = join(dir, 'evaluator'); const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n !== 'PROVENANCE.json') out.push(p); } };
  if (existsSync(root)) walk(root);
  return out;
}

/** Write the pinned digests into course.json. For git fixtures, `fixtureDigest` comes from a prepare. */
export function pinCourse(course, { fixtureDigest } = {}) {
  const doc = course.doc;
  doc.acceptance.evaluatorDigest = evaluatorDigest(course.dir);
  if (doc.environment.fixture.type === 'directory') doc.environment.fixture.digest = directoryFixtureDigest(course.dir, doc);
  else if (fixtureDigest) doc.environment.fixture.digest = fixtureDigest;
  writeJSON(join(course.dir, 'course.json'), doc);
  return loadCourseDir(course.dir);
}

/** The document published to the app (course.json as-is; evaluator files are not part of it). */
export const publicDocument = (course) => course.doc;
