import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON, canonicalDigest } from '../lib/util.mjs';
import { listCourses, validateCourse, loadCourseDir, courseDigest, REQUIRED_SECTIONS } from '../courses/index.mjs';
import { COURSES_DIR } from '../lib/paths.mjs';

test('canonical JSON sorts keys recursively and drops undefined', () => {
  assert.equal(canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalDigest({ a: 1, b: 2 }), canonicalDigest({ b: 2, a: 1 }));
});

test('both v1 courses are valid, pinned, and carry every required section', () => {
  const courses = listCourses();
  assert.deepEqual(courses.map((c) => `${c.id}/${c.version}`), ['course-000-calibration/v1', 'course-001-ddmrv/v1']);
  for (const c of courses) {
    assert.deepEqual(validateCourse(c), [], `${c.id} problems`);
    for (const s of REQUIRED_SECTIONS) assert.ok(c.doc[s] !== undefined, `${c.id} has ${s}`);
    assert.match(c.digest, /^[0-9a-f]{64}$/);
    for (const h of c.doc.acceptance.hidden) assert.ok(h.file.startsWith('evaluator/'));
    for (const k of c.doc.constraints) assert.ok(k.enforcement, `${c.id}/${k.id} states its enforcement`);
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
});

test('validation catches an unpinned evaluator change and evaluator content leaking into the public document', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aoc-course-'));
  try {
    const dir = join(tmp, 'c', 'v1');
    cpSync(join(COURSES_DIR, 'course-000-calibration/v1'), dir, { recursive: true });
    writeFileSync(join(dir, 'evaluator/acceptance/span_acceptance.rs'), readFileSync(join(dir, 'evaluator/acceptance/span_acceptance.rs'), 'utf8') + '\n// changed\n');
    assert.ok(validateCourse(loadCourseDir(dir)).some((p) => /evaluatorDigest is not pinned/.test(p)));
    const doc = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8'));
    doc.objective.publicBrief = 'assert_eq!(total_len(&[(1, 3), (5, 5), (9, 8)]), 4);';
    writeFileSync(join(dir, 'course.json'), JSON.stringify(doc));
    assert.ok(validateCourse(loadCourseDir(dir)).some((p) => /contains evaluator content/.test(p)));
    assert.notEqual(courseDigest(doc), listCourses()[0].digest);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
