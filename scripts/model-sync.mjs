#!/usr/bin/env node
/**
 * npm run model:sync
 *
 * Records the development environment's AppPort Services Intelligence selection
 * (`feltkit model show`) in the app, so the Agent Configuration screen can show it.
 * Intelligence stays authoritative; only the provider, model, endpoint and credential
 * reference are recorded — never a secret value.
 */
import { syncModel, withAdmin } from "./devtools.mjs";

await withAdmin(async (admin) => {
  const m = await syncModel(admin);
  console.log(`Recorded (${admin.mode}): ${m.ready ? "ready" : "not ready"} · ${m.provider ?? "—"} / ${m.model ?? "—"}${m.endpoint ? ` at ${m.endpoint}` : ""}${m.credentialRef ? ` · ${m.credentialRef} (${m.credentialPresent ? "set" : "missing"})` : ""}`);
  for (const p of m.problems) console.log(`  ! ${p}`);
});
