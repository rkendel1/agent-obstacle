/**
 * Experiment definitions: what is covered by the digest, and the secret guard.
 *
 * definition = { agent, model, budgets, obstacles, environment }    (contract ExperimentSnapshot minus ids)
 * digest     = sha256 over canonicalJson(definition)
 *
 * Product settings without a dedicated contract field are carried inside it:
 *   agent.options.capabilities   the capability subset the agent may use (course capabilities ∩ this)
 *   agent.options.recovery       recovery settings (e.g. { allowRetry, maxRecoveries })
 *   agent.options.flags          experimental flags
 *   model.inference              inference settings (temperature, top_p, seed, …)
 */
import { fail } from "@feltdb/feltkit";
import { digestOf } from "./canonical.js";

export interface Definition {
  agent: { adapter: "stack-agent" | "patch-agent" | "reference-control"; version?: string; options?: Record<string, unknown> };
  model: { provider: string; model: string; endpoint?: string; credentialRef?: string; inference?: Record<string, unknown> } | null;
  budgets: { maxTurns: number; maxExecutions: number; deadlineSecs: number; callTimeoutSecs: number; maxOutputTokens?: number };
  obstacles: { enabled: boolean; overrides?: unknown };
  environment: { kind: "local-isolated" };
}

/** Strings that look like secret values. Only `credential-ref:` references may appear. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{12,}/,
  /\bapp_live_[0-9a-f]{6}_/, // AppPort Services API key
  /\bfdb_live_/, // FeltDB key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
];
const SECRET_KEYS = /^(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|auth|authorization|private[_-]?key)$/i;

/** Refuse any value that looks like a secret, and any secret-named field that is not a credential reference. */
export function assertNoSecrets(value: unknown, path = "definition"): void {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) fail("INVALID_ARGUMENT", `${path} looks like a secret value. Store secrets in the host (FELTKIT_CREDENTIAL_<ID>) and reference them as credential-ref:<id>.`, { reason: "secret_value", path });
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k) && !(typeof v === "string" && v.startsWith("credential-ref:")) && v !== null && v !== undefined && v !== false) {
        fail("INVALID_ARGUMENT", `${path}.${k} may only hold a credential reference (credential-ref:<id>), never a value.`, { reason: "secret_value", path: `${path}.${k}` });
      }
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

/** Normalize (drop empty optional fields) so that equal settings give equal digests. */
export function normalizeDefinition(input: Definition): Definition {
  const clean = (o: Record<string, unknown> | undefined) => {
    if (!o) return undefined;
    const entries = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "");
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const agentOptions = clean(input.agent.options);
  const model = input.model
    ? {
        provider: input.model.provider.trim(),
        model: input.model.model.trim(),
        ...(input.model.endpoint?.trim() ? { endpoint: input.model.endpoint.trim() } : {}),
        ...(input.model.credentialRef?.trim() ? { credentialRef: input.model.credentialRef.trim() } : {}),
        ...(clean(input.model.inference) ? { inference: clean(input.model.inference) } : {}),
      }
    : null;
  if (model?.endpoint && !/^https?:\/\/[^\s]+$/.test(model.endpoint)) fail("INVALID_ARGUMENT", "model.endpoint must be an http(s) URL.", { reason: "invalid_endpoint" });
  return {
    agent: { adapter: input.agent.adapter, ...(input.agent.version?.trim() ? { version: input.agent.version.trim() } : {}), ...(agentOptions ? { options: agentOptions } : {}) },
    model,
    budgets: {
      maxTurns: input.budgets.maxTurns,
      maxExecutions: input.budgets.maxExecutions,
      deadlineSecs: input.budgets.deadlineSecs,
      callTimeoutSecs: input.budgets.callTimeoutSecs,
      ...(input.budgets.maxOutputTokens !== undefined ? { maxOutputTokens: input.budgets.maxOutputTokens } : {}),
    },
    obstacles: { enabled: input.obstacles.enabled, ...(input.obstacles.overrides !== undefined && input.obstacles.overrides !== null ? { overrides: input.obstacles.overrides } : {}) },
    environment: { kind: "local-isolated" },
  };
}

export function definitionDigest(definition: Definition): string {
  return digestOf(definition);
}

export function modelLabel(definition: Definition): string {
  return definition.model ? `${definition.model.provider}/${definition.model.model}` : "no model";
}
