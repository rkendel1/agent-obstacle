#!/usr/bin/env node
/**
 * npm run seed:courses [-- --dir <courses dir>] [--dry-run]
 *
 * Publishes every courses/<course>/<version>/course.json (and harness/courses/…) through
 * the `courses.publish@1` capability, as the development admin, together with the version's
 * preflight report (preflight.json next to course.json, written by
 * `npm run courses:preflight -- <course>/<version>`). The app refuses a new version without a
 * passing report for its exact digest, and so does this script before it asks. Only
 * course.json and preflight.json are read; evaluator/ directories and reference fixes are
 * never opened, so the app never receives private material. Publishing is idempotent: an
 * unchanged version reports "unchanged"; a changed document under a published version is
 * refused (bump the version instead).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PROJECT_DIR, syncModel, withAdmin } from "./devtools.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const roots = flag("--dir") ? [resolve(flag("--dir"))] : [join(PROJECT_DIR, "courses"), join(PROJECT_DIR, "harness", "courses")];

function findCourses() {
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const course of readdirSync(root).sort()) {
      const courseDir = join(root, course);
      if (course === "evaluator" || course.startsWith(".") || !statSync(courseDir).isDirectory()) continue;
      for (const version of readdirSync(courseDir).sort()) {
        if (version === "evaluator" || version.startsWith(".")) continue;
        const file = join(courseDir, version, "course.json");
        if (existsSync(file) && !file.split(/[\\/]/).includes("evaluator")) found.push(file);
      }
    }
  }
  return found;
}

const files = findCourses();
if (!files.length) {
  console.log(`No course.json found under ${roots.map((r) => relative(PROJECT_DIR, r) || ".").join(", ")} (layout: courses/<course>/<version>/course.json).`);
  process.exit(0);
}

let refused = 0;
await withAdmin(async (admin) => {
  console.log(`Publishing ${files.length} course version(s) as ada (admin) — ${admin.mode}${dryRun ? " [dry run]" : ""}`);
  for (const file of files) {
    const rel = relative(PROJECT_DIR, file);
    let course;
    try {
      course = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      refused += 1;
      console.log(`  ✗ ${rel}: not valid JSON (${error.message})`);
      continue;
    }
    const preflightFile = join(dirname(file), "preflight.json");
    let preflight = null;
    try {
      preflight = existsSync(preflightFile) ? JSON.parse(readFileSync(preflightFile, "utf8")) : null;
    } catch (error) {
      console.log(`  ! ${relative(PROJECT_DIR, preflightFile)}: not valid JSON (${error.message})`);
    }
    const ref = `${course?.identity?.id}/${course?.identity?.version}`;
    if (!preflight) console.log(`  ! ${rel}: no preflight.json — run npm run courses:preflight -- ${ref} (the app refuses a new version without one)`);
    else if (preflight.result !== "pass") console.log(`  ! ${rel}: preflight.json is a FAILING report; fix the course and run npm run courses:preflight -- ${ref}`);
    if (dryRun) {
      console.log(`  · ${rel}: ${course?.identity?.id}@${course?.identity?.version}${preflight ? ` (preflight ${preflight.result})` : ""}`);
      continue;
    }
    try {
      const input = preflight ? { course, preflight } : { course };
      const out = await admin.invoke("courses.publish", input, `seed:${course?.identity?.id}@${course?.identity?.version}:${Date.now()}`);
      console.log(`  ${out.created ? "✓ published" : "= unchanged"} ${out.ref}  ${out.digest}  (${rel})`);
    } catch (error) {
      refused += 1;
      const problems = error.error?.details?.problems;
      console.log(`  ✗ ${rel}: ${error.message}${problems ? `\n      - ${problems.join("\n      - ")}` : ""}`);
    }
  }
  if (!dryRun) {
    try {
      const m = await syncModel(admin);
      console.log(`Model selection observed: ${m.ready ? `${m.provider} / ${m.model}` : "none ready"}${m.credentialRef ? ` (${m.credentialRef}, ${m.credentialPresent ? "set" : "missing"})` : ""}`);
    } catch (error) {
      console.log(`(Could not observe the model selection: ${error.message})`);
    }
  }
});
process.exit(refused ? 1 : 0);
