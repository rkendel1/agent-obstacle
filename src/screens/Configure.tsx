import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import type { ArgsOf, ResultOf } from "@feltdb/feltkit/client";
import { api } from "../../feltkit/_generated/api";
import { describeError, fmtTime, go, href } from "../lib";
import { useCan } from "../perm";
import { Badge, Card, Chips, Digest, Empty, Field, KV, Loading, Pre, useNotice } from "../ui";

type Experiment = ResultOf<typeof api.experiments.list>[number];
type DefinitionArgs = ArgsOf<typeof api.experiments.preview>;

interface Form {
  lineageId: string | null;
  name: string;
  notes: string;
  adapter: "stack-agent" | "patch-agent" | "reference-control";
  agentVersion: string;
  useModel: boolean;
  provider: string;
  model: string;
  endpoint: string;
  credentialRef: string;
  temperature: string;
  topP: string;
  seed: string;
  inferenceExtra: string;
  capabilities: string;
  maxTurns: string;
  maxExecutions: string;
  deadlineSecs: string;
  callTimeoutSecs: string;
  maxOutputTokens: string;
  allowRetry: boolean;
  maxRecoveries: string;
  obstaclesEnabled: boolean;
  flags: string;
  courseVersionId: string;
}

const BLANK: Form = {
  lineageId: null,
  name: "",
  notes: "",
  adapter: "stack-agent",
  agentVersion: "",
  useModel: true,
  provider: "",
  model: "",
  endpoint: "",
  credentialRef: "",
  temperature: "0",
  topP: "",
  seed: "",
  inferenceExtra: "",
  capabilities: "",
  maxTurns: "50",
  maxExecutions: "50",
  deadlineSecs: "1200",
  callTimeoutSecs: "300",
  maxOutputTokens: "16384",
  allowRetry: true,
  maxRecoveries: "",
  obstaclesEnabled: true,
  flags: "",
  courseVersionId: "",
};

function fromExperiment(e: Experiment): Form {
  const d = e.definition;
  const opts = (d.agent.options ?? {}) as Record<string, any>;
  const inf = { ...((d.model?.inference ?? {}) as Record<string, unknown>) };
  const take = (k: string) => {
    const v = inf[k];
    delete inf[k];
    return v === undefined ? "" : String(v);
  };
  const temperature = take("temperature");
  const topP = take("top_p");
  const seed = take("seed");
  return {
    lineageId: e.lineageId,
    name: e.name,
    notes: e.notes,
    adapter: d.agent.adapter,
    agentVersion: d.agent.version ?? "",
    useModel: d.model !== null,
    provider: d.model?.provider ?? "",
    model: d.model?.model ?? "",
    endpoint: d.model?.endpoint ?? "",
    credentialRef: d.model?.credentialRef ?? "",
    temperature,
    topP,
    seed,
    inferenceExtra: Object.keys(inf).length ? JSON.stringify(inf, null, 2) : "",
    capabilities: Array.isArray(opts.capabilities) ? opts.capabilities.join(", ") : "",
    maxTurns: String(d.budgets.maxTurns),
    maxExecutions: String(d.budgets.maxExecutions),
    deadlineSecs: String(d.budgets.deadlineSecs),
    callTimeoutSecs: String(d.budgets.callTimeoutSecs),
    maxOutputTokens: d.budgets.maxOutputTokens !== undefined ? String(d.budgets.maxOutputTokens) : "",
    allowRetry: opts.recovery?.allowRetry !== false,
    maxRecoveries: opts.recovery?.maxRecoveries !== undefined ? String(opts.recovery.maxRecoveries) : "",
    obstaclesEnabled: d.obstacles.enabled,
    flags: opts.flags ? JSON.stringify(opts.flags, null, 2) : "",
    courseVersionId: e.defaultCourseVersionId ?? "",
  };
}

const int = (s: string, name: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number.`);
  return n;
};
const json = (s: string, name: string): Record<string, unknown> | undefined => {
  if (!s.trim()) return undefined;
  const v = JSON.parse(s);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be a JSON object.`);
  return v as Record<string, unknown>;
};

/** Build the digest-covered definition from the form. Throws a readable error. */
function toDefinition(f: Form): DefinitionArgs {
  const inference: Record<string, unknown> = { ...(json(f.inferenceExtra, "Other inference settings") ?? {}) };
  if (f.temperature.trim()) inference.temperature = Number(f.temperature);
  if (f.topP.trim()) inference.top_p = Number(f.topP);
  if (f.seed.trim()) inference.seed = Number(f.seed);
  for (const [k, v] of Object.entries(inference)) if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`Inference setting ${k} must be a number.`);
  const capabilities = f.capabilities
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const recovery: Record<string, unknown> = { allowRetry: f.allowRetry };
  if (f.maxRecoveries.trim()) recovery.maxRecoveries = int(f.maxRecoveries, "Max recoveries");
  const flags = json(f.flags, "Experimental flags");
  if (f.useModel && (!f.provider.trim() || !f.model.trim())) throw new Error("Choose a model provider and model (or select “No model” for the reference control).");
  return {
    agent: {
      adapter: f.adapter,
      ...(f.agentVersion.trim() ? { version: f.agentVersion.trim() } : {}),
      options: { ...(capabilities.length ? { capabilities } : {}), recovery, ...(flags ? { flags } : {}) },
    },
    model: f.useModel
      ? {
          provider: f.provider.trim(),
          model: f.model.trim(),
          ...(f.endpoint.trim() ? { endpoint: f.endpoint.trim() } : {}),
          ...(f.credentialRef.trim() ? { credentialRef: f.credentialRef.trim() } : {}),
          ...(Object.keys(inference).length ? { inference } : {}),
        }
      : null,
    budgets: {
      maxTurns: int(f.maxTurns, "Max turns"),
      maxExecutions: int(f.maxExecutions, "Max tool executions"),
      deadlineSecs: int(f.deadlineSecs, "Wall-clock deadline"),
      callTimeoutSecs: int(f.callTimeoutSecs, "Per-call timeout"),
      ...(f.maxOutputTokens.trim() ? { maxOutputTokens: int(f.maxOutputTokens, "Output token cap") } : {}),
    },
    obstacles: { enabled: f.obstaclesEnabled },
    environment: { kind: "local-isolated" },
  };
}

export function Configure({ params }: { params: URLSearchParams }) {
  const experiments = useQueryState(api.experiments.list);
  const published = useQueryState(api.courses.published);
  const environment = useQueryState(api.models.environment);
  const save = useMutation(api.experiments.save);
  const launch = useMutation(api.runs.launch);
  const canWrite = useCan("experiments.write");
  const canLaunch = useCan("runs.launch");
  const { notify, fail } = useNotice();
  const [form, setForm] = useState<Form>(() => ({ ...BLANK, courseVersionId: params.get("course") ?? "" }));
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Open an experiment from the URL (?experiment=<id>) once the list has loaded.
  const wanted = params.get("experiment");
  useEffect(() => {
    if (!wanted || loadedId || !experiments.data) return;
    const e = experiments.data.find((x) => x.experimentId === wanted || x.lineageId === wanted);
    if (e) {
      setForm({ ...fromExperiment(e), courseVersionId: params.get("course") ?? e.defaultCourseVersionId ?? "" });
      setLoadedId(e.experimentId);
    }
  }, [wanted, loadedId, experiments.data, params]);

  const course = useQueryState(api.courses.get, form.courseVersionId ? { courseVersionId: form.courseVersionId } : "skip");
  const built = useMemo(() => {
    try {
      return { definition: toDefinition(form), error: null as string | null };
    } catch (e) {
      return { definition: null, error: (e as Error).message };
    }
  }, [form]);
  const preview = useQueryState(api.experiments.preview, built.definition ?? "skip");
  const loaded = experiments.data?.find((e) => e.experimentId === loadedId) ?? null;
  const unchanged = !!loaded && preview.data?.digest === loaded.digest && form.name.trim() === loaded.name && form.notes.trim() === loaded.notes && (form.courseVersionId || null) === loaded.defaultCourseVersionId;

  const persist = async () => {
    if (!built.definition) throw new Error(built.error ?? "The configuration is incomplete.");
    if (!form.name.trim()) throw new Error("Name the experiment.");
    const saved = await save({
      ...(form.lineageId ? { lineageId: form.lineageId } : {}),
      name: form.name,
      ...(form.notes.trim() ? { notes: form.notes } : {}),
      ...(form.courseVersionId ? { defaultCourseVersionId: form.courseVersionId } : {}),
      ...built.definition,
    });
    setForm((f) => ({ ...f, lineageId: saved.lineageId }));
    setLoadedId(saved.experimentId);
    return saved;
  };

  const onSave = async () => {
    setBusy(true);
    try {
      const saved = await persist();
      notify("ok", saved.unchanged ? `No change: revision ${saved.revision} is current.` : `Saved revision ${saved.revision} (${saved.digest.slice(0, 19)}…).`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const onLaunch = async () => {
    setBusy(true);
    try {
      if (!form.courseVersionId) throw new Error("Choose a course version to launch against.");
      const saved = await persist();
      const { runId } = await launch({ experimentId: saved.experimentId, courseVersionId: form.courseVersionId });
      notify("ok", "Run requested. The harness admits it into the work authority.");
      go(`runs/${runId}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const useEnvironment = () => {
    const env = environment.data;
    if (!env) return;
    setForm((f) => ({ ...f, useModel: true, provider: env.provider ?? "", model: env.model ?? "", endpoint: env.endpoint ?? "", credentialRef: env.credentialRef ?? "" }));
  };

  const courseCaps = course.data?.display.capabilities ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agent Configuration</h1>
          <p className="muted">A saved, reproducible experiment definition. Its digest is sha256 over the canonical JSON of agent, model, budgets, obstacles and environment. Editing a saved experiment creates a new revision.</p>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => (setForm({ ...BLANK, courseVersionId: form.courseVersionId }), setLoadedId(null))}>
            New experiment
          </button>
        </div>
      </div>
      <div className="split wide-left">
        <div className="stack">
          <Card title={loaded ? `Editing “${loaded.name}” · revision ${loaded.revision}` : "New experiment"} actions={preview.data ? <Digest value={preview.data.digest} /> : null}>
            <fieldset disabled={!canWrite} className="form-grid">
              <Field label="Name">
                <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} placeholder="e.g. Stack-Agent + Qwen 3B, defaults" />
              </Field>
              <Field label="Course version" hint="Runs pin this immutable version and its digest.">
                <select value={form.courseVersionId} onChange={(e) => set("courseVersionId", e.target.value)}>
                  <option value="">Choose…</option>
                  {(published.data ?? []).map((v) => (
                    <option key={v.courseVersionId} value={v.courseVersionId}>
                      {v.name} · {v.ref}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notes" wide>
                <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={4000} />
              </Field>
            </fieldset>
          </Card>

          <Card title="Agent">
            <fieldset disabled={!canWrite} className="form-grid">
              <Field label="Adapter">
                <select value={form.adapter} onChange={(e) => set("adapter", e.target.value as Form["adapter"])}>
                  <option value="stack-agent">stack-agent (Chip)</option>
                  <option value="patch-agent">patch-agent</option>
                  <option value="reference-control">reference-control (applies the known fix; calibrates the course)</option>
                </select>
              </Field>
              <Field label="Agent version" hint="Recorded; the harness also records what actually ran.">
                <input value={form.agentVersion} onChange={(e) => set("agentVersion", e.target.value)} placeholder="e.g. 0.1.0" />
              </Field>
              <Field label="Capabilities subset" hint={courseCaps.length ? <>Course offers: <Chips items={courseCaps} /></> : "Comma-separated; empty = everything the course allows."} wide>
                <input value={form.capabilities} onChange={(e) => set("capabilities", e.target.value)} placeholder="shell, read_file, write_file" />
              </Field>
            </fieldset>
          </Card>

          <Card title="Model">
            <div className="callout">
              <div>
                <b>Environment selection</b> <span className="muted">(AppPort Services Intelligence)</span>
                {environment.data ? (
                  <div className="muted small">
                    {environment.data.provider ?? "—"} / {environment.data.model ?? "—"}
                    {environment.data.endpoint ? ` at ${environment.data.endpoint}` : ""}
                    {environment.data.credentialRef ? ` · ${environment.data.credentialRef} (${environment.data.credentialPresent ? "set" : "missing"})` : ""} · observed {fmtTime(environment.data.observedAt)}
                    {!environment.data.ready && <span className="warn-text"> · not ready: {environment.data.problems.join("; ")}</span>}
                  </div>
                ) : (
                  <div className="muted small">
                    Not observed yet. Select a model in Studio → Models (or <code>npx feltkit model set</code>), then run <code>npm run model:sync</code>.
                  </div>
                )}
              </div>
              <button className="secondary" disabled={!canWrite || !environment.data?.model} onClick={useEnvironment}>
                Use this selection
              </button>
            </div>
            <fieldset disabled={!canWrite} className="form-grid">
              <label className="check wide">
                <input type="checkbox" checked={!form.useModel} onChange={(e) => set("useModel", !e.target.checked)} /> No model (reference control)
              </label>
              {form.useModel && (
                <>
                  <Field label="Provider">
                    <input value={form.provider} onChange={(e) => set("provider", e.target.value)} placeholder="custom, openai, anthropic, ollama…" />
                  </Field>
                  <Field label="Model">
                    <input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="qwen2.5-coder-3b" />
                  </Field>
                  <Field label="Endpoint">
                    <input value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="http://127.0.0.1:8081/v1/chat/completions" />
                  </Field>
                  <Field label="Credential reference" hint="A reference only (credential-ref:<id>); the value lives in the host as FELTKIT_CREDENTIAL_<ID>. Secret values are refused.">
                    <input value={form.credentialRef} onChange={(e) => set("credentialRef", e.target.value)} placeholder="credential-ref:local-llm" autoComplete="off" />
                  </Field>
                  <Field label="Temperature">
                    <input inputMode="decimal" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} />
                  </Field>
                  <Field label="top_p">
                    <input inputMode="decimal" value={form.topP} onChange={(e) => set("topP", e.target.value)} />
                  </Field>
                  <Field label="Seed">
                    <input inputMode="numeric" value={form.seed} onChange={(e) => set("seed", e.target.value)} />
                  </Field>
                  <Field label="Other inference settings (JSON)" wide>
                    <textarea rows={2} className="mono" value={form.inferenceExtra} onChange={(e) => set("inferenceExtra", e.target.value)} placeholder='{"structured_output": "schema"}' />
                  </Field>
                </>
              )}
            </fieldset>
          </Card>

          <Card title="Budgets, recovery and environment">
            <fieldset disabled={!canWrite} className="form-grid">
              <Field label="Max turns">
                <input inputMode="numeric" value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} />
              </Field>
              <Field label="Max tool executions">
                <input inputMode="numeric" value={form.maxExecutions} onChange={(e) => set("maxExecutions", e.target.value)} />
              </Field>
              <Field label="Wall-clock deadline (s)" hint="Enforced by the harness (process-group kill), not only by the agent.">
                <input inputMode="numeric" value={form.deadlineSecs} onChange={(e) => set("deadlineSecs", e.target.value)} />
              </Field>
              <Field label="Per-call timeout (s)">
                <input inputMode="numeric" value={form.callTimeoutSecs} onChange={(e) => set("callTimeoutSecs", e.target.value)} />
              </Field>
              <Field label="Output token cap">
                <input inputMode="numeric" value={form.maxOutputTokens} onChange={(e) => set("maxOutputTokens", e.target.value)} />
              </Field>
              <Field label="Environment">
                <input value="local-isolated" readOnly aria-readonly />
              </Field>
              <label className="check">
                <input type="checkbox" checked={form.obstaclesEnabled} onChange={(e) => set("obstaclesEnabled", e.target.checked)} /> Inject the course's obstacles
              </label>
              <label className="check">
                <input type="checkbox" checked={form.allowRetry} onChange={(e) => set("allowRetry", e.target.checked)} /> Allow agent retries after a failure
              </label>
              <Field label="Max recoveries">
                <input inputMode="numeric" value={form.maxRecoveries} onChange={(e) => set("maxRecoveries", e.target.value)} placeholder="unbounded" />
              </Field>
              <Field label="Experimental flags (JSON)" wide>
                <textarea rows={2} className="mono" value={form.flags} onChange={(e) => set("flags", e.target.value)} placeholder='{"structuredOutput": "schema"}' />
              </Field>
            </fieldset>
          </Card>

          <div className="sticky-actions">
            {built.error ? <span className="error-text">{built.error}</span> : preview.error ? <span className="error-text">{describeError(preview.error)}</span> : <span className="muted">{unchanged ? "Saved: this is the current revision." : loaded ? "Saving creates a new revision." : "Not saved yet."}</span>}
            <span className="row">
              <button className="secondary" disabled={busy || !canWrite || !!built.error} onClick={onSave}>
                {loaded ? "Save revision" : "Save experiment"}
              </button>
              <button className="primary" disabled={busy || !canWrite || !canLaunch || !!built.error || !form.courseVersionId} onClick={onLaunch}>
                Save &amp; launch
              </button>
            </span>
          </div>
        </div>

        <div className="stack">
          <Card title="Saved experiments">
            {experiments.isLoading && !experiments.data ? (
              <Loading />
            ) : !experiments.data?.length ? (
              <Empty title="No experiments yet." />
            ) : (
              <ul className="list">
                {experiments.data.map((e) => (
                  <li key={e.experimentId} className={`list-row selectable ${e.experimentId === loadedId ? "selected" : ""}`}>
                    <button className="link" onClick={() => (setForm({ ...fromExperiment(e), courseVersionId: form.courseVersionId || (e.defaultCourseVersionId ?? "") }), setLoadedId(e.experimentId))}>
                      <b>{e.name}</b>
                    </button>
                    <span className="muted small">
                      r{e.revision} · {e.adapter} · {e.modelLabel}
                    </span>
                    <Digest value={e.digest} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {loaded && <Revisions lineageId={loaded.lineageId} />}
          {preview.data && (
            <Card title="Definition (canonical input to the digest)">
              <Pre value={preview.data.definition} />
            </Card>
          )}
          {course.data && (
            <Card title="Course">
              <KV
                rows={[
                  ["Version", <a href={href(`course/${encodeURIComponent(course.data.courseVersionId)}`)}>{course.data.ref}</a>],
                  ["Digest", <Digest value={course.data.digest} />],
                  ["Limits", course.data.display.limits],
                  ["Compatible", course.data.display.compatible || "any"],
                  ["Status", <Badge tone={course.data.status === "published" ? "pass" : "warn"}>{course.data.status}</Badge>],
                ]}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Revisions({ lineageId }: { lineageId: string }) {
  const revisions = useQueryState(api.experiments.revisions, { lineageId });
  if (!revisions.data || revisions.data.length < 2) return null;
  return (
    <Card title="Revisions">
      <ul className="list">
        {revisions.data.map((r) => (
          <li key={r.experimentId} className="list-row">
            <span>r{r.revision}</span>
            <span className="muted small">
              {fmtTime(r.createdAt)} · {r.createdBy}
            </span>
            <Digest value={r.digest} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
