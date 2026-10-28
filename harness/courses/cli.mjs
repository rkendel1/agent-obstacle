#!/usr/bin/env node
// npm run courses:list | courses:validate | courses:pin [-- --prepare] | courses:prepare -- <course/v> [--adopt DIR] | courses:export [-- --out DIR]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCourses, validateCourse, pinCourse, loadCourseRef, publicDocument } from './index.mjs';
import { prepareFixture } from './fixtures.mjs';

const [cmd, ...args] = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const log = (m) => console.log(`[courses] ${m}`);

switch (cmd) {
  case 'list':
    for (const c of listCourses()) console.log(`${c.id}/${c.version}  ${c.digest}  ${c.doc.identity.title}`);
    break;
  case 'validate': {
    let bad = 0;
    for (const c of listCourses()) {
      const p = validateCourse(c);
      console.log(`${p.length ? 'INVALID' : 'ok     '} ${c.id}/${c.version} ${c.digest}`);
      for (const x of p) console.log(`   - ${x}`);
      bad += p.length;
    }
    process.exitCode = bad ? 1 : 0;
    break;
  }
  case 'pin':
    for (const c of listCourses()) {
      let fixtureDigest;
      if (c.doc.environment.fixture.type === 'git' && args.includes('--prepare')) fixtureDigest = prepareFixture(c, { log }).fixtureDigest;
      const p = pinCourse(c, { fixtureDigest });
      log(`pinned ${p.id}/${p.version} -> course digest ${p.digest}`);
    }
    break;
  case 'prepare': {
    const c = loadCourseRef(args[0]);
    const f = prepareFixture(c, { log, adopt: opt('adopt') });
    log(`${c.id}/${c.version}: ${f.cached ? 'cached' : 'prepared'} ${f.tree} base ${f.baseCommit} fixture digest ${f.fixtureDigest}`);
    break;
  }
  case 'export': {
    const out = opt('out');
    const docs = listCourses().map((c) => ({ courseId: c.id, version: c.version, digest: c.digest, document: publicDocument(c) }));
    if (out) { mkdirSync(out, { recursive: true }); for (const d of docs) writeFileSync(join(out, `${d.courseId}@${d.version}.json`), JSON.stringify(d, null, 2) + '\n'); log(`exported ${docs.length} course version(s) to ${out}`); }
    else console.log(JSON.stringify(docs, null, 2));
    break;
  }
  default:
    console.error('usage: cli.mjs list | validate | pin [--prepare] | prepare <course/version> [--adopt DIR] | export [--out DIR]');
    process.exitCode = 2;
}
