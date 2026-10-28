---
name: feltkit-operations
description: Diagnose, build, test, deploy, and recover FeltKit applications — feltkit doctor, inspect, build, test, deploy, start, sessions, environments, state locations, production configuration (FELTDB_URL, FELTDB_TOKEN, FELTKIT_STATE_DIR), and release. Use when something will not start, a port or instance is already in use, the user wants to ship or deploy, rotate access, or recover state.
---

# FeltKit: operations

## Diagnose first

```sh
npx feltkit doctor --json     # Node, project, dependencies, one FeltDB copy, frontend tooling, dev server
npx feltkit inspect --json    # application, environment, instance, functions, services, recent activity
```

`inspect` reads the running server when there is one, otherwise opens the environment directly. It never prints the
admin token. Share findings, not tokens.

| Problem | Meaning | Fix |
|---|---|---|
| `DUPLICATE_INSTANCE` / "already running" | Another process owns this environment's FeltDB instance | Stop it, or use that server; never point two processes at the same state |
| `Port … is already in use` | — | `--port <n>` |
| "Two copies of @feltdb/core" (doctor) | Mismatched dependency versions | Reinstall; pins must agree (doctor prints the fix) |
| `CONFIGURATION: FELTDB_URL is set for production but FELTDB_TOKEN is not` | — | Set the token from the secret manager |
| A function fails only in production | Production hides internal error messages | Read the server logs and Studio's Activity for the request id |

## Environments and state

| Environment | State |
|---|---|
| development | `.feltkit/development/state` (local FeltDB) |
| test | a fresh temporary directory per test runtime |
| production | `FELTDB_URL` + `FELTDB_TOKEN` (a FeltDB server), else `FELTKIT_STATE_DIR`, else `.feltkit/production/state` |

`.feltkit/` holds state and the admin token (mode 0600). Never commit it, never paste the token. Back up state by
copying the stopped state directory; restore by putting it back before starting.

## Build, test, deploy

```sh
npx feltkit test              # node --test on tests/**/*.test.ts, isolated FeltDB per runtime
npx feltkit build             # bundles feltkit/, builds the frontend, loads the bundle to verify it
npx feltkit deploy --out dist-deploy   # verified, self-contained directory with a Dockerfile and DEPLOY.md
npx feltkit start --port 8080 --host 0.0.0.0   # production runtime (the dashboard is not served)
```

`build` refuses to ship a frontend that contains secrets (FELTDB_TOKEN, FeltKit tokens, server code).

## Access

```sh
npx feltkit session create --id ci-bot --role <role> --type agent --ttl 24
npx feltkit session list
npx feltkit session revoke <ref>
```

Revoking a session stops its durable work too (jobs and deliveries it created are refused). API keys are managed on
the API keys page (Studio → Services → Manage). Production API keys need `FELTKIT_API_KEY_VERIFIER_KEY`.

## Recover

- A failed job or delivery: see the feltkit-services skill; retry or replay after fixing the cause.
- A `CONFLICT` storm: two writers contend; retry with a bound, or narrow what the mutation reads.
- The agent cannot act for a task: its owner has no active session or key; create one or reassign the work.

## Requires approval

Anything in production; deleting or restoring state; revoking sessions or keys; rotating
`FELTKIT_API_KEY_VERIFIER_KEY`; publishing packages (`npm run publish:packages` in the FeltKit repository).

## Compatibility

`@feltdb/feltkit` 0.1.x. Verified in Claude Code only.
