import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { api } from "../../feltkit/_generated/api";
import { fmtBytes, fmtDuration, fmtNumber, fmtTime, go, href } from "../lib";
import { useCan } from "../perm";
import { Badge, Card, Digest, Empty, ErrorBox, KV, Loading, OutcomeBadge, Pre, Tabs, useNotice } from "../ui";

type Run = ResultOf<typeof api.runs.get>;
type RunEvent = ResultOf<typeof api.runs.events>["events"][number];

const STAGE_ORDER = ["prepare", "observe-before", "agent", "observe-after", "evaluate", "report"];
const LANES = [
  { id: "claims", title: "Agent claims", sources: ["agent"], hint: "What the agent says about itself. Untrusted; never counted as success." },
  { id: "observed", title: "Runtime observed", sources: ["runtime", "pax", "harness"], hint: "What the harness, the runtime and PAX recorded happening." },
  { id: "verified", title: "Evaluator verified", sources: ["evaluator"], hint: "What the independent evaluator checked, in a fresh copy of the workspace." },
] as const;

export function RunScreen({ runId }: { runId: string }) {
  const run = useQueryState(api.runs.get, { runId });
  const [tab, setTab] = useState<"live" | "report" | null>(null);
  if (run.isLoading && !run.data) return <Loading what="Loading run" />;
  if (run.error && !run.data) return <ErrorBox error={run.error} />;
  const r = run.data!;
  const current = tab ?? (r.state === "terminal" ? "report" : "live");
  return (
    <div className="page">
      <RunHeader run={r} />
      <Tabs
        label="Run view"
        value={current}
        onChange={setTab}
        options={[
          { id: "live", label: r.state === "terminal" ? "Trace" : "Live" },
          { id: "report", label: "Report" },
        ]}
      />
      {current === "live" ? <Live run={r} /> : <Report run={r} />}
    </div>
  );
}

function RunHeader({ run }: { run: Run }) {
  const cancel = useMutation(api.runs.cancel);
  const rerun = useMutation(api.runs.rerun);
  const canCancel = useCan("runs.cancel");
  const canLaunch = useCan("runs.launch");
  const { notify, fail } = useNotice();
  return (
    <div className="page-head">
      <div>
        <p className="crumbs">
          <a href={href("history")}>Runs</a> / <span className="mono">{run.runId}</span>
        </p>
        <h1 className="row">
          <a href={href(`course/${encodeURIComponent(run.courseVersionId)}`)}>{run.courseRef}</a>
          <OutcomeBadge outcome={run.outcome} state={run.state === "running" && run.stage ? `running · ${run.stage}` : run.state} />
          {run.cancelRequested && run.state !== "terminal" && <Badge tone="warn">cancel requested</Badge>}
        </h1>
        <p className="muted">
          {run.experimentName ?? run.experimentId} {run.experimentRevision ? `r${run.experimentRevision}` : ""} · {run.adapter} · {run.modelLabel} · requested by {run.requestedBy} {fmtTime(run.requestedAt)}
          {run.rerunOf && (
            <>
              {" "}
              · rerun of <a href={href(`runs/${run.rerunOf}`)}>{run.rerunOf}</a>
            </>
          )}
        </p>
      </div>
      <div className="row">
        {run.state !== "terminal" && canCancel && !run.cancelRequested && (
          <button className="danger" onClick={() => cancel({ runId: run.runId }).then(() => notify("info", run.state === "requested" ? "Cancelled before admission." : "Cancel requested. The harness cancels the workload.")).catch(fail)}>
            Cancel run
          </button>
        )}
        {canLaunch && (
          <button className="secondary" onClick={() => rerun({ runId: run.runId }).then(({ runId }) => go(`runs/${runId}`)).catch(fail)} title="A new run from the same saved experiment revision and the same course version">
            Rerun
          </button>
        )}
        <a className="button ghost" href={href("compare", { version: run.courseVersionId })}>
          Compare
        </a>
      </div>
    </div>
  );
}

function useEvents(runId: string) {
  const events = useQueryState(api.runs.events, { runId, tail: 500 });
  return { list: events.data?.events ?? [], hasEarlier: events.data?.hasEarlier ?? false, loading: events.isLoading && !events.data };
}

function countKinds(events: RunEvent[]) {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}

function latestBudget(events: RunEvent[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "budget" && events[i]!.data && typeof events[i]!.data === "object") return events[i]!.data as Record<string, unknown>;
  return null;
}

function Live({ run }: { run: Run }) {
  const course = useQueryState(api.courses.get, { courseVersionId: run.courseVersionId });
  const { list, hasEarlier, loading } = useEvents(run.runId);
  const [selected, setSelected] = useState<RunEvent | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.state === "terminal") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run.state]);
  const kinds = useMemo(() => countKinds(list), [list]);
  const budget = latestBudget(list);
  const b = run.experiment.budgets;
  const elapsedMs = run.startedAt ? (run.terminalAt ?? now) - run.startedAt : null;
  const num = (k: string) => (budget && typeof budget[k] === "number" ? (budget[k] as number) : null);
  const turnsUsed = num("turnsUsed") ?? num("turns");
  const execUsed = num("executionsUsed") ?? num("executions") ?? (kinds["tool.call"] ?? null);
  const lastAgent = [...list].reverse().find((e) => e.source === "agent");
  const verification = [...list].reverse().find((e) => e.source === "evaluator");

  return (
    <div className="stack">
      <div className="split">
        <Card title="Objective and stages">
          <p className="objective">{course.data?.display.objective || <span className="muted">Loading objective…</span>}</p>
          <StageTimeline run={run} />
        </Card>
        <Card title="Status">
          <KV
            rows={[
              ["Projection state", <OutcomeBadge outcome={run.outcome} state={run.state} />],
              ["Workload", run.workloadId ? <span className="mono">{run.workloadId}</span> : <span className="muted">not admitted yet</span>],
              ["Attempt · fence", run.attemptNumber ? `#${run.attemptNumber} · token ${run.fencingToken}` : null],
              ["Agent status", lastAgent ? <span title="Agent's own words (untrusted)">“{lastAgent.summary}”</span> : run.stage === "agent" ? "running" : null],
              ["Model calls", fmtNumber(kinds["model.call"] ?? 0)],
              ["Tool calls · results", `${kinds["tool.call"] ?? 0} · ${kinds["tool.result"] ?? 0}`],
              ["File changes", fmtNumber(kinds["file.change"] ?? 0)],
              ["Failures · recoveries", `${(kinds["failure"] ?? 0) + (kinds["error"] ?? 0)} · ${kinds["recovery"] ?? 0}`],
              ["Tests executed", fmtNumber((kinds["test"] ?? 0) + (kinds["pax.test"] ?? 0))],
              ["Elapsed / deadline", `${fmtDuration(elapsedMs)} / ${fmtDuration(b.deadlineSecs * 1000)}`],
              ["Turns remaining", turnsUsed !== null ? `${Math.max(0, b.maxTurns - turnsUsed)} of ${b.maxTurns}` : `${b.maxTurns} max (usage not observed yet)`],
              ["Executions remaining", execUsed !== null ? `${Math.max(0, b.maxExecutions - execUsed)} of ${b.maxExecutions}` : `${b.maxExecutions} max`],
              ["Verification", run.result ? <Badge tone={run.result.evaluation.acceptance === "pass" ? "pass" : "fail"}>acceptance {run.result.evaluation.acceptance}</Badge> : verification ? verification.summary : "not run yet"],
              ["Events · evidence", `${run.eventCount} · ${run.evidenceCount}`],
            ]}
          />
        </Card>
      </div>
      {loading ? (
        <Loading what="Loading events" />
      ) : !list.length ? (
        <Empty title={run.state === "requested" ? "Waiting for the harness to admit this run." : "No events yet."}>
          {run.state === "requested" && <>The harness dispatcher polls <code>runs.pending</code>; start it with the commands in the README.</>}
        </Empty>
      ) : (
        <>
          {hasEarlier && <p className="muted small">Showing the latest 500 of {run.eventCount} events.</p>}
          <div className="lanes">
            {LANES.map((lane) => (
              <Lane key={lane.id} title={lane.title} hint={lane.hint} events={list.filter((e) => (lane.sources as readonly string[]).includes(e.source))} onSelect={setSelected} selected={selected} live={run.state !== "terminal"} />
            ))}
          </div>
        </>
      )}
      {selected && (
        <Card title={`Event #${selected.seq} · ${selected.kind}`} actions={<button className="ghost" onClick={() => setSelected(null)}>Close</button>}>
          <KV rows={[["Source", <SourceBadge source={selected.source} />], ["At", fmtTime(selected.at)], ["Summary", selected.summary]]} />
          {selected.data !== null && <Pre value={selected.data} />}
        </Card>
      )}
      <EvidenceList runId={run.runId} />
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const tone = source === "agent" ? "claim" : source === "evaluator" ? "verified" : "observed";
  return <Badge tone={tone}>{source}</Badge>;
}

function Lane({ title, hint, events, onSelect, selected, live }: { title: string; hint: string; events: RunEvent[]; onSelect: (e: RunEvent) => void; selected: RunEvent | null; live: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, live]);
  const tone = title.startsWith("Agent") ? "claim" : title.startsWith("Evaluator") ? "verified" : "observed";
  return (
    <section className={`lane lane-${tone}`} aria-label={title}>
      <header>
        <h3>{title}</h3>
        <span className="muted small">{hint}</span>
      </header>
      {events.length === 0 ? (
        <p className="muted small pad">Nothing yet.</p>
      ) : (
        <ol ref={ref} className="events">
          {events.map((e) => (
            <li key={e.seq}>
              <button className={`event ${selected?.seq === e.seq ? "selected" : ""}`} onClick={() => onSelect(e)}>
                <span className="event-meta">
                  <span className="mono">#{e.seq}</span> <span className="kind">{e.kind}</span> <span className="muted">{new Date(e.at).toLocaleTimeString()}</span>
                  {e.source !== "agent" && e.source !== "evaluator" && <span className="muted"> · {e.source}</span>}
                </span>
                <span className="event-summary">{e.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function StageTimeline({ run }: { run: Run }) {
  const byStage = new Map<string, { status: string; at: string; attempt: number }[]>();
  for (const s of run.stages) byStage.set(s.stage, [...(byStage.get(s.stage) ?? []), { status: s.status, at: s.at, attempt: s.attemptNumber }]);
  const names = [...STAGE_ORDER, ...[...byStage.keys()].filter((s) => !STAGE_ORDER.includes(s))];
  return (
    <ol className="timeline">
      {names.map((name) => {
        const entries = byStage.get(name) ?? [];
        const last = entries[entries.length - 1];
        const started = entries.find((e) => e.status === "started");
        const finished = [...entries].reverse().find((e) => e.status !== "started");
        const status = last?.status ?? "pending";
        const dur = started && finished ? Date.parse(finished.at) - Date.parse(started.at) : null;
        return (
          <li key={name} className={`stage ${status}`}>
            <span className="stage-dot" aria-hidden />
            <span className="stage-name">{name}</span>
            <span className="muted small">
              {status}
              {dur !== null && dur >= 0 ? ` · ${fmtDuration(dur)}` : ""}
              {entries.some((e) => e.attempt > 1) ? ` · attempt ${Math.max(...entries.map((e) => e.attempt))}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceList({ runId }: { runId: string }) {
  const items = useQueryState(api.runs.evidenceIndex, { runId });
  const [open, setOpen] = useState<string | null>(null);
  if (!items.data?.length) return null;
  return (
    <Card title={`Evidence (${items.data.length})`}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Kind</th>
              <th>Source</th>
              <th>Digest</th>
              <th>Size / path</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.data.map((e) => (
              <tr key={e.evidenceId}>
                <td>{e.label}</td>
                <td className="mono">{e.kind}</td>
                <td>
                  <SourceBadge source={e.source} />
                </td>
                <td>
                  <Digest value={e.digest} />
                </td>
                <td className="muted">{e.hasContent ? fmtBytes(e.size) : <span className="mono">{e.path}</span>}</td>
                <td>{e.hasContent && <button className="link" onClick={() => setOpen(open === e.evidenceId ? null : e.evidenceId)}>{open === e.evidenceId ? "Hide" : "View"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <EvidenceContent runId={runId} evidenceId={open} />}
    </Card>
  );
}

function EvidenceContent({ runId, evidenceId }: { runId: string; evidenceId: string }) {
  const item = useQueryState(api.runs.evidenceContent, { runId, evidenceId });
  if (!item.data) return <Loading />;
  return (
    <div className="mt">
      <p className="muted small">
        {item.data.label} · rendered as text (untrusted content) · <Digest value={item.data.digest} />
      </p>
      <Pre value={item.data.content ?? ""} className="tall" />
    </div>
  );
}

function YesNo({ value }: { value: boolean | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">not observed</span>;
  return value ? <Badge tone="pass">yes</Badge> : <Badge tone="fail">no</Badge>;
}

const CHECK_TONE: Record<string, string> = { pass: "pass", fail: "fail", "not-run": "muted", error: "error" };

function Report({ run }: { run: Run }) {
  const { list } = useEvents(run.runId);
  const res = run.result;
  if (!res) {
    return (
      <Empty title={run.cancelledBeforeAdmission ? "Cancelled before admission: no work was started." : "No result yet."}>
        {run.cancelledBeforeAdmission ? "The run was cancelled while it was still only a request, so the harness never ran it." : "The report appears when the harness reports the terminal result (runs.completed)."}
      </Empty>
    );
  }
  const kinds = countKinds(list);
  const criticalCompleted = res.evaluation.violations.filter((v) => v.completed && v.severity === "critical").length;
  const metricKeys = Object.keys(res.metrics).sort();
  const exp = run.experiment;
  return (
    <div className="stack">
      <section className={`verdict verdict-${res.outcome.toLowerCase()}`} aria-label="Overall outcome">
        <div>
          <span className="verdict-label">Overall outcome</span>
          <span className="verdict-value">{res.outcome}</span>
        </div>
        <div className="muted">
          {res.failureClass ? (
            <>
              Failure classification: <b>{res.failureClass}</b>
            </>
          ) : res.outcome === "PASS" ? (
            "Verified by the evaluator; no completed critical violation."
          ) : null}
          <div>
            {fmtTime(res.startedAt)} → {fmtTime(res.completedAt)} · {fmtDuration(res.observed.durationMs)}
          </div>
        </div>
      </section>

      <div className="lanes">
        <section className="lane lane-claim" aria-label="Agent claims">
          <header>
            <h3>Agent claims</h3>
            <span className="muted small">Untrusted. Never decides the outcome.</span>
          </header>
          <div className="pad">
            <KV rows={[["Terminal state", res.claims.agentTerminalState], ["Says it verified", <YesNo value={res.claims.agentSaysVerified} />]]} />
            {res.claims.summary && <Pre value={res.claims.summary} />}
          </div>
        </section>
        <section className="lane lane-observed" aria-label="Runtime observed">
          <header>
            <h3>Runtime observed</h3>
            <span className="muted small">Process, time, budgets.</span>
          </header>
          <div className="pad">
            <KV rows={[["Exit code", res.observed.exitCode ?? null], ["Signal", res.observed.signal ?? null], ["Duration", fmtDuration(res.observed.durationMs)], ["Timed out", <YesNo value={res.observed.timedOut} />]]} />
          </div>
        </section>
        <section className="lane lane-verified" aria-label="Evaluator verified">
          <header>
            <h3>Evaluator verified</h3>
            <span className="muted small">{res.evaluation.evaluatorVersion}</span>
          </header>
          <div className="pad">
            <KV
              rows={[
                ["Acceptance", <Badge tone={CHECK_TONE[res.evaluation.acceptance] ?? "neutral"}>{res.evaluation.acceptance}</Badge>],
                ["Regression", res.evaluation.regression ? <Badge tone={CHECK_TONE[res.evaluation.regression] ?? "neutral"}>{res.evaluation.regression}</Badge> : null],
                ["Checks passed", `${res.evaluation.checks.filter((c) => c.result === "pass").length} of ${res.evaluation.checks.length}`],
                ["Critical violations completed", criticalCompleted],
              ]}
            />
          </div>
        </section>
      </div>

      <div className="split">
        <Card title="Objective completion (acceptance checks)">
          {res.evaluation.checks.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {res.evaluation.checks.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td>
                        <Badge tone={CHECK_TONE[c.result] ?? "neutral"}>{c.result}</Badge>
                      </td>
                      <td className="pre-line">{c.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">The evaluator ran no checks.</p>
          )}
        </Card>
        <Card title="Safety and constraint violations">
          {res.evaluation.violations.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Constraint</th>
                    <th>Severity</th>
                    <th>Attempted</th>
                    <th>Completed</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {res.evaluation.violations.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">{v.id}</td>
                      <td>
                        <Badge tone={v.severity === "critical" ? "error" : v.severity === "major" ? "warn" : "neutral"}>{v.severity}</Badge>
                      </td>
                      <td>
                        <YesNo value={v.attempted} />
                      </td>
                      <td>{v.completed ? <Badge tone="fail">completed</Badge> : <Badge tone="pass">blocked</Badge>}</td>
                      <td className="pre-line">{v.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No violation attempted or completed.</p>
          )}
        </Card>
      </div>

      <div className="split">
        <Card title="Recovery history">
          {res.recovery.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Obstacle</th>
                    <th>Injected</th>
                    <th>Recognized</th>
                    <th>Recovered</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {res.recovery.map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.obstacleId ?? "—"}</td>
                      <td>
                        <YesNo value={r.injected} />
                      </td>
                      <td>
                        <YesNo value={r.recognized} />
                      </td>
                      <td>
                        <YesNo value={r.recovered} />
                      </td>
                      <td className="pre-line">{r.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No obstacle was injected.</p>
          )}
        </Card>
        <Card title="Time, resources and tool use">
          <KV
            rows={[
              ["Duration", fmtDuration(res.observed.durationMs)],
              ...metricKeys.map((k) => [k, fmtNumber(res.metrics[k])] as [string, string]),
              ["Events by kind", Object.keys(kinds).length ? Object.entries(kinds).map(([k, n]) => `${k}: ${n}`).join(" · ") : null],
            ]}
          />
          <p className="muted small">Metrics the harness did not observe are shown as “not observed”, never estimated.</p>
        </Card>
      </div>

      <div className="split">
        <Card title="Execution trace">
          <StageTimeline run={run} />
          <p className="muted small">
            {run.eventCount} events, {run.evidenceCount} evidence items. Open the Trace tab for the full three-lane trace.
          </p>
        </Card>
        <Card title="Model and runtime configuration">
          <KV
            rows={[
              ["Experiment", <a href={href("configure", { experiment: run.experimentId })}>{run.experimentName ?? run.experimentId}{run.experimentRevision ? ` r${run.experimentRevision}` : ""}</a>],
              ["Adapter", `${exp.agent.adapter}${exp.agent.version ? ` ${exp.agent.version}` : ""}`],
              ["Agent version (ran)", res.reproducibility.agentVersion ?? null],
              ["Model", exp.model ? `${exp.model.provider} / ${exp.model.model}` : "none"],
              ["Endpoint", exp.model?.endpoint ?? null],
              ["Credential", exp.model?.credentialRef ?? null],
              ["Inference", exp.model?.inference ? JSON.stringify(exp.model.inference) : null],
              ["Budgets", `${exp.budgets.maxTurns} turns · ${exp.budgets.maxExecutions} executions · ${exp.budgets.deadlineSecs}s deadline · ${exp.budgets.callTimeoutSecs}s/call${exp.budgets.maxOutputTokens ? ` · ${exp.budgets.maxOutputTokens} output tokens` : ""}`],
              ["Obstacles", exp.obstacles.enabled ? "injected" : "disabled"],
              ["Work authority", run.workAuthority ? `${run.workAuthority.release} · ${run.workAuthority.namespace} @ ${run.workAuthority.url}` : null],
              ["Workload · attempt", run.workloadId ? `${run.workloadId} · #${run.attemptNumber ?? "?"}` : null],
            ]}
          />
        </Card>
      </div>

      <Card title="Reproduction">
        <KV
          rows={[
            ["Configuration reproducible", <><Badge tone="pass">yes</Badge> <span className="muted small">course and experiment digests are pinned and immutable</span></>],
            ["Behaviourally deterministic", <YesNo value={res.reproducibility.deterministic} />],
            ["Note", res.reproducibility.note],
            ["Course digest", <Digest value={res.reproducibility.courseDigest} />],
            ["Experiment digest", <Digest value={res.reproducibility.experimentDigest} />],
            ["Fixture digest", res.reproducibility.fixtureDigest ? <Digest value={res.reproducibility.fixtureDigest} /> : null],
            ["Final tree digest", res.reproducibility.finalTreeDigest ? <Digest value={res.reproducibility.finalTreeDigest} /> : null],
            ["Versions", [res.reproducibility.agentVersion, res.reproducibility.paxVersion, res.reproducibility.evaluatorVersion, res.reproducibility.workAuthorityRelease].filter(Boolean).join(" · ")],
          ]}
        />
        <ol className="steps">
          <li>
            Rerun from this page (same experiment revision <span className="mono">{run.experimentId}</span>, same course version <span className="mono">{run.courseRef}</span>).
          </li>
          <li>The harness re-verifies both digests before it starts; a changed course or definition cannot run under these ids.</li>
          <li>{res.reproducibility.deterministic ? "This course and configuration are expected to reproduce the same behaviour." : "Expect configuration-identical but not behaviour-identical runs (model sampling, timing); compare distributions across reruns."}</li>
        </ol>
      </Card>
      <EvidenceList runId={run.runId} />
    </div>
  );
}
