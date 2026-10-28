import type { ReactNode } from "react";
import { useQueryState } from "@feltdb/feltkit/react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { api } from "../../feltkit/_generated/api";
import { fmtDuration, fmtNumber, fmtPct, go, href } from "../lib";
import { Card, Digest, Empty, ErrorBox, Field, Loading } from "../ui";

type Comparison = ResultOf<typeof api.runs.compare>;
type Group = Comparison["groups"][number];
type Dist = Group["durationMs"];

const OUTCOME_ORDER = ["PASS", "FAIL", "BLOCKED", "ERROR", "CANCELLED"] as const;

function dist(d: Dist, format: (n: number | null) => string = (n) => fmtNumber(n)): ReactNode {
  if (!d.observed) return <span className="muted">not observed</span>;
  return (
    <span>
      {format(d.median)} <span className="muted small">median · p90 {format(d.p90)} · n={d.observed}{d.notObserved ? `, ${d.notObserved} not observed` : ""}</span>
    </span>
  );
}

function OutcomeBar({ group }: { group: Group }) {
  const total = group.terminal || 1;
  return (
    <div className="outcome-bar" role="img" aria-label={OUTCOME_ORDER.map((o) => `${o} ${group.outcomes[o] ?? 0}`).join(", ")}>
      {OUTCOME_ORDER.map((o) => {
        const n = group.outcomes[o] ?? 0;
        return n ? <span key={o} className={`seg seg-${o.toLowerCase()}`} style={{ width: `${(n / total) * 100}%` }} title={`${o}: ${n}`} /> : null;
      })}
    </div>
  );
}

export function Compare({ params }: { params: URLSearchParams }) {
  const runIds = params.get("runs")?.split(",").filter(Boolean) ?? [];
  const version = params.get("version") ?? "";
  const published = useQueryState(api.courses.published);
  const cmp = useQueryState(api.runs.compare, runIds.length ? { runIds } : version ? { courseVersionId: version } : "skip");

  const data = cmp.data;
  const groups = data?.groups ?? [];
  const metricKeys = [...new Set(groups.flatMap((g) => Object.keys(g.metrics)))].sort();
  const rows: Array<[string, (g: Group) => ReactNode]> = [
    ["Runs (terminal / all)", (g) => `${g.terminal} / ${g.runs}`],
    ["Outcomes", (g) => (
      <div>
        <OutcomeBar group={g} />
        <span className="small muted">{OUTCOME_ORDER.map((o) => `${o} ${g.outcomes[o] ?? 0}`).join(" · ")}</span>
      </div>
    )],
    ["Verified completion", (g) => (g.verifiedCompletion.rate === null ? <span className="muted">no decided runs</span> : <span>{fmtPct(g.verifiedCompletion.rate)} <span className="muted small">{g.verifiedCompletion.pass} PASS of {g.verifiedCompletion.decided} decided (cancelled excluded)</span></span>)],
    ["Acceptance checks passed (per run)", (g) => dist(g.checkPassRatio, fmtPct)],
    ["Wall-clock time", (g) => dist(g.durationMs, fmtDuration)],
    ...metricKeys.map((k) => [k, (g: Group) => (g.metrics[k] ? dist(g.metrics[k]!) : <span className="muted">not observed</span>)] as [string, (g: Group) => ReactNode]),
    ["Recovery success", (g) => (g.recovery.injected ? <span>{fmtPct(g.recovery.rate)} <span className="muted small">{g.recovery.recovered} recovered · {g.recovery.notRecovered} not · {g.recovery.unknown} not observed, of {g.recovery.injected} injected</span></span> : <span className="muted">no obstacle injected</span>)],
    ["Violations", (g) => <span>{g.violations.attempted} attempted · {g.violations.completed} completed · <b className={g.violations.criticalCompleted ? "error-text" : ""}>{g.violations.criticalCompleted} critical completed</b></span>],
    ["Failure categories", (g) => (Object.keys(g.failureClasses).length ? Object.entries(g.failureClasses).map(([k, n]) => `${k} ${n}`).join(" · ") : <span className="muted">none</span>)],
    ["Behaviourally deterministic runs", (g) => `${g.deterministic} of ${g.terminal}`],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Comparison</h1>
          <p className="muted">Only runs of one course version are compared. Each dimension stands alone: there is no single opaque score, and anything a run did not report is “not observed”, never estimated.</p>
        </div>
        <Field label="Course version">
          <select value={data?.courseVersionId ?? version} onChange={(e) => go("compare", { version: e.target.value })}>
            <option value="">Choose…</option>
            {(published.data ?? []).map((v) => (
              <option key={v.courseVersionId} value={v.courseVersionId}>
                {v.ref}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!runIds.length && !version ? (
        <Empty title="Choose a course version to compare the experiments that ran on it." />
      ) : cmp.isLoading && !data ? (
        <Loading what="Comparing" />
      ) : cmp.error ? (
        <ErrorBox error={cmp.error} />
      ) : !groups.length ? (
        <Empty title="No finished runs on this course version yet." />
      ) : (
        <Card
          title={
            <>
              <a href={href(`course/${encodeURIComponent(data!.courseVersionId)}`)}>{data!.ref}</a> <Digest value={data!.digest} />
            </>
          }
          actions={<span className="muted small">{runIds.length ? `${data!.runCount} selected runs` : `${data!.runCount} finished runs${data!.truncated ? " (newest 500)" : ""}`}</span>}
        >
          <div className="table-wrap">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">Dimension</th>
                  {groups.map((g) => (
                    <th scope="col" key={g.experimentId}>
                      <a href={href("history", { version: data!.courseVersionId, experiment: undefined })}>{g.experimentName}</a>
                      <div className="muted small">
                        {g.revision ? `r${g.revision} · ` : ""}
                        {g.adapter} · {g.modelLabel}
                      </div>
                      <Digest value={g.digest} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, cell]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {groups.map((g) => (
                      <td key={g.experimentId}>{cell(g)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Cost appears only when the harness measured it (metric <code>costUsd</code>); tokens only where the model endpoint reported usage.</p>
        </Card>
      )}
    </div>
  );
}
