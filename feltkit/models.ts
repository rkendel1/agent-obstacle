/**
 * The environment's model selection, as AppPort Services Intelligence holds it.
 *
 * FeltKit 0.2.0 functions cannot read Intelligence directly (platform collections are not
 * reachable through ctx.db, and ctx.services has no intelligence binding). An admin
 * records what `feltkit model show --json` reports (`npm run model:sync`), and the Agent
 * Configuration screen shows that dated observation. Intelligence stays authoritative;
 * an experiment records the provider/model/endpoint/credentialRef it will run with.
 * Secret values never pass through here: only the credential reference and whether it resolves.
 */
import { s } from "@feltdb/feltkit";
import { app, modelObservations } from "./app.js";
import { assertNoSecrets } from "./lib/experiment.js";

const Observation = {
  ready: s.boolean(),
  source: s.string({ maxLength: 40 }),
  provider: s.optional(s.nullable(s.string({ maxLength: 80 }))),
  model: s.optional(s.nullable(s.string({ maxLength: 200 }))),
  endpoint: s.optional(s.nullable(s.string({ maxLength: 500 }))),
  protocol: s.optional(s.nullable(s.string({ maxLength: 80 }))),
  credentialRef: s.optional(s.nullable(s.string({ pattern: "^credential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" }))),
  credentialPresent: s.optional(s.boolean()),
  problems: s.optional(s.array(s.string({ maxLength: 1000 }), { maxItems: 20 })),
};

export const record = app.mutation({
  access: "models.record",
  args: Observation,
  returns: s.object({ ok: s.literal(true), observationId: s.string() }),
  capability: {
    name: "models.environment.record",
    description: "Record the environment's AppPort Services Intelligence selection as observed (provider, model, endpoint, credential reference; never a secret).",
  },
  handler: async (ctx, input) => {
    assertNoSecrets(input, "observation");
    const id = await ctx.db.insert(modelObservations, {
      environment: ctx.environment.name,
      ready: input.ready,
      source: input.source,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.protocol ? { protocol: input.protocol } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      credentialPresent: input.credentialPresent ?? false,
      problems: input.problems ?? [],
      observedAt: Date.now(),
      observedBy: ctx.auth.requirePrincipal().id,
    });
    return { ok: true as const, observationId: id };
  },
});

/** The newest observation for this environment, or null. */
export const environment = app.query({
  access: "models.read",
  handler: async (ctx) => {
    const [latest] = await ctx.db.find(modelObservations, { environment: ctx.environment.name }, { orderBy: [{ field: "observedAt", direction: "desc" }], limit: 1 });
    if (!latest) return null;
    return {
      environment: latest.environment,
      ready: latest.ready,
      source: latest.source,
      provider: latest.provider ?? null,
      model: latest.model ?? null,
      endpoint: latest.endpoint ?? null,
      protocol: latest.protocol ?? null,
      credentialRef: latest.credentialRef ?? null,
      credentialPresent: latest.credentialPresent,
      problems: latest.problems,
      observedAt: latest.observedAt,
      observedBy: latest.observedBy,
    };
  },
});
