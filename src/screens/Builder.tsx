import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { describeError, go, href } from "../lib";
import { useCan } from "../perm";
import { Badge, Card, Digest, ErrorBox, Field, Loading, Pre, Tabs, useNotice } from "../ui";

const SECTIONS = ["objective", "environment", "capabilities", "constraints", "obstacles", "acceptance", "scoring", "evidence", "cleanup", "meta"] as const;
type Section = (typeof SECTIONS)[number];

const HELP: Record<Section, string> = {
  objective: "What the agent is asked to achieve (a string, or an object with a summary).",
  environment: "What the attempt runs in: toolchain, network, fixture. The harness enforces what it can and says what it cannot.",
  capabilities: "Tools the agent may use. An experiment can narrow this, never widen it.",
  constraints: "Rules with ids and severities (critical / major / minor). Violations are recorded as attempted vs completed.",
  obstacles: "What gets in the way, when, and how it is injected (deterministic, randomized or adversarial).",
  acceptance: "What the independent evaluator checks. Hidden checks stay in the harness's evaluator/ directory and never come here. Frozen at publish.",
  scoring: "Separate dimensions (completion, safety, recovery, efficiency…). No single opaque score.",
  evidence: "What is captured: diffs, processes, PAX observations, test results.",
  cleanup: "What is removed after the attempt.",
  meta: "{ skills: string[], difficulty, kind: deterministic | randomized | adversarial, expectedRuntimeSecs, limits, compatible? }",
};

const TEMPLATE: Record<string, unknown> = {
  identity: { id: "my-course", version: "1.0.0", name: "My course", description: "One paragraph: what this course tests and why." },
  objective: "Describe the task the agent must complete.",
  environment: { kind: "local-isolated", fixture: "fixture/", network: "none" },
  capabilities: { tools: ["shell", "read_file", "write_file"] },
  constraints: [{ id: "no-test-edits", severity: "critical", rule: "Do not modify the tests." }],
  obstacles: [],
  acceptance: { summary: "The evaluator's tests pass in a fresh copy of the final workspace.", checks: ["visible-tests", "hidden-acceptance"] },
  scoring: { dimensions: ["completion", "safety", "recovery", "efficiency"] },
  evidence: { capture: ["diff", "process", "pax.test"] },
  cleanup: { remove: [] },
  meta: { skills: [], difficulty: "medium", kind: "deterministic", expectedRuntimeSecs: 600, limits: { maxTurns: 50, deadlineSecs: 1200 } },
};

function bump(version: string): string {
  const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (semver) return `${semver[1]}.${Number(semver[2]) + 1}.0`;
  const v = /^v(\d+)$/.exec(version);
  if (v) return `v${Number(v[1]) + 1}`;
  return `${version}-2`;
}

interface State {
  identity: { id: string; version: string; name: string; description: string };
  sections: Record<Section, string>;
  extra: Record<string, unknown>;
}

function toState(doc: Record<string, unknown>): State {
  const id = (doc.identity ?? {}) as Record<string, unknown>;
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, doc[s] === undefined ? "" : JSON.stringify(doc[s], null, 2)])) as Record<Section, string>;
  const extra = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "identity" && !(SECTIONS as readonly string[]).includes(k)));
  return { identity: { id: String(id.id ?? ""), version: String(id.version ?? ""), name: String(id.name ?? ""), description: String(id.description ?? "") }, sections, extra };
}

function toDoc(state: State): { doc: Record<string, unknown> | null; errors: Partial<Record<Section, string>> } {
  const errors: Partial<Record<Section, string>> = {};
  const doc: Record<string, unknown> = { ...state.extra, identity: { ...state.identity } };
  for (const s of SECTIONS) {
    const text = state.sections[s].trim();
    if (!text) {
      errors[s] = "required";
      continue;
    }
    try {
      doc[s] = JSON.parse(text);
    } catch (e) {
      errors[s] = (e as Error).message;
    }
  }
  return { doc: Object.keys(errors).length ? null : doc, errors };
}

export function Builder({ params }: { params: URLSearchParams }) {
  const from = params.get("from");
  const draftId = params.get("draft");
  const source = useQueryState(api.courses.get, from || draftId ? { courseVersionId: (draftId ?? from)! } : "skip");
  const createDraft = useMutation(api.courses.createDraft);
  const updateDraft = useMutation(api.courses.updateDraft);
  const discardDraft = useMutation(api.courses.discardDraft);
  const publishDraft = useMutation(api.courses.publishDraft);
  const canDraft = useCan("courses.draft");
  const canPublish = useCan("courses.publish");
  const { notify, fail } = useNotice();
  const [state, setState] = useState<State | null>(from || draftId ? null : toState(TEMPLATE));
  const [tab, setTab] = useState<"identity" | Section | "document">("identity");
  const [serverProblems, setServerProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state || !source.data) return;
    const doc = (source.data.spec ?? {}) as Record<string, unknown>;
    const next = toState(doc);
    if (from && !draftId) next.identity.version = bump(next.identity.version);
    setState(next);
  }, [source.data, state, from, draftId]);

  const built = useMemo(() => (state ? toDoc(state) : { doc: null, errors: {} }), [state]);
  if ((from || draftId) && source.isLoading && !source.data) return <Loading what="Loading course" />;
  if (source.error && !source.data) return <ErrorBox error={source.error} />;
  if (!state) return <Loading />;

  const editingDraft = draftId && source.data?.status === "draft" ? source.data : null;
  const readOnly = !!draftId && source.data?.status === "published";
  const setIdentity = (k: keyof State["identity"], v: string) => setState((s) => s && { ...s, identity: { ...s.identity, [k]: v } });
  const setSection = (k: Section, v: string) => setState((s) => s && { ...s, sections: { ...s.sections, [k]: v } });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setServerProblems(null);
    try {
      await work();
    } catch (e) {
      const problems = (e as { details?: { problems?: string[] } }).details?.problems;
      if (problems?.length) setServerProblems(problems);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!built.doc) throw new Error("Fix the highlighted sections first.");
      if (editingDraft) {
        await updateDraft({ courseVersionId: editingDraft.courseVersionId, spec: built.doc });
        notify("ok", "Draft saved.");
      } else {
        const created = await createDraft({ spec: built.doc, ...(from ? { derivedFrom: from } : {}) });
        notify("ok", `Draft ${created.ref} created.`);
        go("builder", { draft: created.courseVersionId });
      }
    });

  const publish = () =>
    run(async () => {
      if (!editingDraft) return;
      if (!window.confirm(`Publish ${editingDraft.ref}? A published version is immutable: its acceptance, obstacles and every other field can never change again.`)) return;
      // Save first so that what is published is what is on screen; the digest guards against concurrent edits.
      if (built.doc) await updateDraft({ courseVersionId: editingDraft.courseVersionId, spec: built.doc });
      const fresh = await publishDraft({ courseVersionId: editingDraft.courseVersionId });
      notify("ok", `Published ${fresh.ref} (${fresh.digest.slice(0, 19)}…).`);
      go(`course/${encodeURIComponent(fresh.courseVersionId)}`);
    });

  const discard = () =>
    run(async () => {
      if (!editingDraft || !window.confirm(`Discard the draft ${editingDraft.ref}?`)) return;
      await discardDraft({ courseVersionId: editingDraft.courseVersionId });
      notify("info", "Draft discarded.");
      go("library");
    });

  const errorCount = Object.keys(built.errors).length;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <a href={href("library")}>Courses</a> / Builder
          </p>
          <h1 className="row">
            {editingDraft ? `Draft ${editingDraft.ref}` : from ? `Variation of ${source.data?.ref ?? ""}` : "New course version"}
            {editingDraft && <Badge tone="warn">draft</Badge>}
            {readOnly && <Badge tone="pass">published · read-only</Badge>}
          </h1>
          <p className="muted">A structured course.json. Publishing creates an immutable version with a sha256 digest over canonical JSON; acceptance cannot change after publish (and no run can start on a draft).</p>
        </div>
        <div className="row">
          {editingDraft && <Digest value={editingDraft.digest} />}
          {editingDraft && canDraft && (
            <button className="ghost danger-text" disabled={busy} onClick={discard}>
              Discard
            </button>
          )}
          <button className="secondary" disabled={busy || !canDraft || readOnly || errorCount > 0} onClick={save}>
            {editingDraft ? "Save draft" : "Create draft"}
          </button>
          {editingDraft && (
            <button className="primary" disabled={busy || !canPublish || errorCount > 0} onClick={publish} title={canPublish ? undefined : "Publishing is admin-only"}>
              Publish version
            </button>
          )}
        </div>
      </div>
      {!canDraft && <p className="notice-inline">Your role can read courses but not draft them.</p>}
      {serverProblems && (
        <div className="error-box" role="alert">
          <b>The document was refused:</b>
          <ul>
            {serverProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <Tabs
        label="Section"
        value={tab}
        onChange={setTab}
        options={[
          { id: "identity", label: "identity" },
          ...SECTIONS.map((s) => ({ id: s, label: built.errors[s] ? <span className="error-text">{s} ⚠</span> : s })),
          { id: "document", label: "Whole document" },
        ]}
      />
      <Card>
        {tab === "identity" ? (
          <fieldset className="form-grid" disabled={readOnly || !canDraft}>
            <Field label="Course id" hint="Lowercase slug; stable across versions.">
              <input value={state.identity.id} onChange={(e) => setIdentity("id", e.target.value)} />
            </Field>
            <Field label="Version" hint="A new version for every change: published versions never change.">
              <input value={state.identity.version} onChange={(e) => setIdentity("version", e.target.value)} />
            </Field>
            <Field label="Name" wide>
              <input value={state.identity.name} onChange={(e) => setIdentity("name", e.target.value)} />
            </Field>
            <Field label="Description" wide>
              <textarea rows={4} value={state.identity.description} onChange={(e) => setIdentity("description", e.target.value)} />
            </Field>
          </fieldset>
        ) : tab === "document" ? (
          built.doc ? <Pre value={built.doc} className="tall" /> : <p className="error-text">{errorCount} section(s) are not valid JSON yet.</p>
        ) : (
          <div>
            <p className="muted">{HELP[tab]}</p>
            <textarea
              className={`code ${built.errors[tab] ? "invalid" : ""}`}
              aria-label={`${tab} (JSON)`}
              aria-invalid={!!built.errors[tab]}
              spellCheck={false}
              rows={18}
              readOnly={readOnly || !canDraft}
              value={state.sections[tab]}
              onChange={(e) => setSection(tab, e.target.value)}
            />
            {built.errors[tab] && <p className="error-text small">{built.errors[tab] === "required" ? "This section is required." : `Not valid JSON: ${describeError(built.errors[tab])}`}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
