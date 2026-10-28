---
name: feltkit-services
description: Configure, use, and troubleshoot AppPort Services in a FeltKit application — files, notifications, configuration and secrets, API keys, webhooks, jobs, schedules, intelligence. Use when the user wants to enable a service, send a notification, enqueue background work, emit or debug a webhook, issue or revoke an API key, set a configuration variable or secret, or asks why a job or delivery failed.
---

# FeltKit: services

Services are AppPort Services running on the application's own FeltDB instance. Every service effect is
authorized by AppPort Services' gateway with the application's roles, as the caller. **This skill grants no
permission and stores no secret.**

## Enable a service

```ts
// feltkit/app.ts
export const app = feltkit({
  name: "shop",
  roles: { admin: ["*"], ops: ["jobs.*", "webhooks.*", "orders.*"] },
  services: {
    files: true,
    notifications: true,
    configuration: true,
    apiKeys: { roles: ["machine"] },          // requests with an API key hold these roles
    webhooks: true,
    jobs: { handlers: { "invoice.send": "billing:sendInvoice" } }, // job type → "<module>:<function>"
    schedules: true,                          // needs jobs
    intelligence: true,                       // the environment's model; agent decisions use it (feltkit model set)
  },
});
```

The permission for each operation is its AppPort Services capability name (`jobs.create`, `webhooks.register`,
`apikeys.create`, `configuration.write`, `credential.attach`, …). Grant them to roles like any permission.

## Use a service from a function

```ts
export const checkout = app.mutation({
  access: "orders.write",
  args: { orderId: s.string() },
  handler: async (ctx, { orderId }) => {
    await ctx.services.jobs.enqueue("invoice.send", { orderId });          // runs later, as this caller
    await ctx.services.webhooks.emit("order.paid", { orderId });           // to subscribed endpoints
    await ctx.services.notifications.send({ recipient: "ada", type: "order", title: "Paid" });
    const region = await ctx.services.configuration.get("REGION");
    return { region };
  },
});
```

Service effects commit on their own: they are not part of the mutation's transaction.

## Configure a service

Configuration happens in AppPort Services' own pages, opened from FeltKit Studio: **Services → Manage**, acting as a
declared dev identity (development only). Those pages are the package's; FeltKit only signs you in. Do not write a
second configuration form or store settings elsewhere.

**Secrets.** Services store only references: `credential-ref:<id>`. FeltKit resolves a reference from the
environment variable `FELTKIT_CREDENTIAL_<ID>` (non-alphanumerics → `_`, upper-cased), inside the one effect that
needs it. Example: a webhook endpoint with `credential-ref:stripe-signing` signs with `FELTKIT_CREDENTIAL_STRIPE_SIGNING`.
Never put a secret value in code, configuration variables, a commit, a log, or a reply. Ask the user to set the
variable themselves. Studio's Services screen shows each reference as set or missing — never its value.

**API keys** are shown once when created (or rotated). FeltKit accepts them on `/appport` and `/mcp` as an identity
holding `services.apiKeys.roles`. In production `FELTKIT_API_KEY_VERIFIER_KEY` (≥ 32 bytes) must be set; changing it
invalidates every key.

**Moving configuration to production.** `feltkit config export --out config.json` writes development's variables,
credential binding names and references, active webhook endpoints, and enabled schedules (never a secret value).
`feltkit config import config.json --env production --dry-run` shows the plan; run it again without `--dry-run`,
on the host with the server stopped, to apply it. Imports never create credential bindings: attach each one it
lists and have the user set its `FELTKIT_CREDENTIAL_<ID>`. Schedules are listed, not imported.

## Troubleshoot

Service states in Studio and `npx feltkit inspect --json`: `available` (not enabled), `unconfigured`, `configured`,
`unhealthy` (store check failed, a required secret is missing, or recent work failed), `unavailable`.

| Symptom | Look at | Usual cause |
|---|---|---|
| Job `failed` | Services → Job runs (`lastError`), Activity filtered to `via: job` | The handler function threw; or `DENIED` — the enqueuer no longer has an active session or key |
| Job never runs | `services.jobs.handlers` | No handler for the type (enqueue refuses unknown types) |
| Delivery `failed` | Services → Webhook deliveries (`lastStatusCode`, `lastError`), Credentials | Signing credential not set; receiver returned 4xx (not retried); destination did not resolve |
| Endpoint rejected on registration | the error | Private/loopback URLs are refused outside development |
| Variable set in the page is missing in code | the environment | The page edits the running environment's scope; check `ctx.environment.name` |

Durable work (jobs, schedules, deliveries) re-authorizes every attempt **as the principal that created it**. If
that principal signs out everywhere or its key is revoked, its pending work is refused — by design.

Retry or replay from Studio (Job runs → Retry, Deliveries → Replay), or ask the FeltKit agent to diagnose it
(see the feltkit-agent skill). In tests, drive due work explicitly: `await app.runtime.runServices()`.

## Requires approval

Revoking or rotating API keys, disabling endpoints, deleting configuration or secrets, and replaying deliveries
affect other systems. Confirm with the user before doing any of them.

## Compatibility

`@feltdb/feltkit` 0.1.x with `@appport/services` 0.7.0 (shared instance). The console is development-only.
Verified in Claude Code only.
