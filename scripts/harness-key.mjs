#!/usr/bin/env node
/**
 * npm run harness:key [-- --name <label>] [--out <file>]
 *
 * Development only. Creates an AppPort Services API key as the development admin. Every
 * API key of this app authenticates as an identity holding exactly the `harness` role
 * (feltkit/app.ts: services.apiKeys.roles), i.e. the harness contract capabilities and
 * nothing else. The secret is shown once: with --out it is written to a 0600 file
 * instead of the terminal. Revoke keys in Studio → Services → API keys.
 */
import { writeFileSync } from "node:fs";
import { withAdmin } from "./devtools.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = flag("--name") ?? "aoc-harness";
const out = flag("--out");

await withAdmin(async (admin) => {
  const key = await admin.createApiKey(name);
  const secret = key.secret ?? key.key ?? key.apiKey;
  if (!secret) throw new Error("The API key service returned no secret.");
  if (out) {
    writeFileSync(out, `${secret}\n`, { mode: 0o600 });
    console.log(`Created API key "${name}" (${key.id ?? key.record?.id ?? "id hidden"}) holding role harness — ${admin.mode}.\nSecret written to ${out} (0600). Use it as Authorization: Bearer <secret> on POST /appport.`);
  } else {
    console.log(`Created API key "${name}" holding role harness — ${admin.mode}. Shown once:\n\n  ${secret}\n\nUse it as Authorization: Bearer <secret> on POST /appport. Prefer --out <file> to keep it out of terminal history.`);
  }
});
