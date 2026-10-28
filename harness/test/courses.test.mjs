import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, canonicalDigest } from '../lib/util.mjs';
import { listCourses, validateCourse, loadCourseDir, courseDigest, REQUIRED_SECTIONS, leakedFiles, privateFiles, readPreflight } from '../courses/index.mjs';
import { courseVariant, privateCourse } from './helpers.mjs';

test('canonical JSON sorts keys recursively and drops undefined', () => {
  assert.equal(canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalDigest({ a: 1, b: 2 }), canonicalDigest({ b: 2, a: 1 }));
});

test('both v1 courses are valid, pinned, declare their evaluator explicitly, and carry every required section', () => {
  const courses = listCourses();
  assert.deepEqual(courses.map((c) => `${c.id}/${c.version}`), ['course-000-calibration/v1', 'course-001-ddmrv/v1']);
  for (const c of courses) {
    assert.deepEqual(validateCourse(c), [], `${c.id} problems`);
    for (const s of REQUIRED_SECTIONS) assert.ok(c.doc[s] !== undefined, `${c.id} has ${s}`);
    assert.match(c.digest, /^sha256:[0-9a-f]{64}$/);
    for (const k of c.doc.constraints) assert.ok(k.enforcement, `${c.id}/${k.id} states its enforcement`);
  }
  const [c0, c1] = courses;
  assert.equal(c0.doc.evaluator.kind, 'declarative');
  assert.equal(c0.doc.acceptance.schema, 'acceptance.v1');
  assert.equal(existsSync(join(c0.dir, 'evaluator')), false);
  assert.equal(c1.doc.evaluator.kind, 'private');
  assert.equal(c1.doc.acceptance.schema, 'aoc.private-acceptance.v1');
  for (const h of c1.doc.acceptance.hidden) assert.ok(h.file.startsWith('evaluator/'));
});

test('each shipped course has a passing preflight report for its exact digest, and neither the document nor the report leaks private content', () => {
  for (const c of listCourses()) {
    const report = readPreflight(c);
    assert.ok(report, `${c.id} has preflight.json (npm run courses:preflight)`);
    assert.equal(report.schema, 'aoc.preflight.v1');
    assert.equal(report.course.digest, c.digest, `${c.id}: preflight.json is for the current course.json`);
    assert.equal(report.result, 'pass');
    assert.ok(report.gates.every((g) => g.result === 'pass'));
    assert.equal(report.evaluator.kind, c.doc.evaluator.kind);
    assert.ok(privateFiles(c).length > 0, `${c.id} has private material (a reference fix at least)`);
    assert.deepEqual(leakedFiles(c, JSON.stringify(c.doc)), [], `${c.id}: course.json`);
    assert.deepEqual(leakedFiles(c, readFileSync(join(c.dir, 'preflight.json'), 'utf8')), [], `${c.id}: preflight.json`);
  }
});

test('course-001 objective is T4.goal.txt verbatim and historical settings are labelled as such', () => {
  const c = listCourses().find((x) => x.id === 'course-001-ddmrv');
  const t4 = '/home/user/stack-agent/docs/product/coding-benchmark-v1/tasks/T4.goal.txt';
  try { assert.equal(c.doc.objective.goal, readFileSync(t4, 'utf8').replace(/\n+$/, '')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(Buffer.byteLength(c.doc.objective.goal), 1829);
  const h = c.doc.meta.historicalSettings;
  assert.deepEqual([h.maxTurns, h.maxExecutions, h.deadlineSecs, h.callTimeoutSecs, h.maxOutputTokens], [50, 50, 1200, 300, 16384]);
  assert.match(h.note, /NOT defaults/);
  assert.equal(c.doc.environment.fixture.commit, '268c9b46a71a5f2b4aea86d6c73a4a4371958f1f');
  assert.equal(c.doc.obstacles.default[0].type, 'transient-test-failure');
  const prov = JSON.parse(readFileSync(join(c.dir, 'evaluator/PROVENANCE.json'), 'utf8'));
  assert.equal(prov.source.commit, '96fa787230556eea81d158d9c31f0ecc19d127a0');
  // the established T4 baseline/reference expectations are declared (and checked by preflight), not weakened
  const id = 'acceptance:spec/test/resolver-multi-version-acceptance.test.ts';
  assert.deepEqual(c.doc.acceptance.preflight, { baseline: { mustFail: [id], mustPass: ['regression'], counts: { [id]: { passed: 2, failed: 6 } } }, reference: { counts: { [id]: { passed: 8, failed: 0 } } } });
  assert.deepEqual(c.doc.acceptance.regression.knownFlaky, ['spec/test/integration-e2e.test.ts']);
});

test('validation catches an unpinned private evaluator change, an unpinned reference, and private content leaking into the public document', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aoc-course-'));
  try {
    const p = privateCourse(tmp);
    assert.deepEqual(validateCourse(p), []);
    writeFileSync(join(p.dir, 'evaluator/acceptance/span_acceptance.rs'), readFileSync(join(p.dir, 'evaluator/acceptance/span_acceptance.rs'), 'utf8') + '\n// changed\n');
    assert.ok(validateCourse(loadCourseDir(p.dir)).some((x) => /evaluator.digest is not pinned/.test(x)));
    const doc = JSON.parse(readFileSync(join(p.dir, 'course.json'), 'utf8'));
    doc.objective.publicBrief = 'assert_eq!(total_len(&[(1, 3), (5, 5), (9, 8)]), 4);';
    writeFileSync(join(p.dir, 'course.json'), JSON.stringify(doc));
    assert.ok(validateCourse(loadCourseDir(p.dir)).some((x) => /contains private evaluator content/.test(x)));
    assert.notEqual(courseDigest(doc), listCourses()[0].digest);

    const d = courseVariant(tmp, 'decl');
    writeFileSync(join(d.dir, 'reference/fix.diff'), readFileSync(join(d.dir, 'reference/fix.diff'), 'utf8').replace('+ 1', '+ 2'));
    assert.ok(validateCourse(loadCourseDir(d.dir)).some((x) => /reference.digest is not pinned/.test(x)));
    const none = courseVariant(tmp, 'none', (doc) => { doc.evaluator = { kind: 'none', reason: 'not written yet' }; });
    assert.ok(validateCourse(none).some((x) => /every run of this course ends ERROR/.test(x)));
    const missing = courseVariant(tmp, 'missing', (doc) => { delete doc.evaluator; });
    assert.ok(validateCourse(missing).some((x) => /missing section evaluator/.test(x)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
