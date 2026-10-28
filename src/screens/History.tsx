import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { fmtDuration, fmtTime, go, href } from "../lib";
import { useCan } from "../perm";
import { Badge, Card, Empty, ErrorBox, Field, Loading, OutcomeBadge, useNotice } from "../ui";

const OUTCOMES = ["PASS", "FAIL", "BLOCKED", "ERROR", "CANCELLED", "pending"];

export function History({ params }: { params: URLSearchParams }) {
  const [filters, setFilters] = useState({
    courseVersionId: params.get("version") ?? "",
    experimentLineageId: params.get("experiment") ?? "",
    adapter: params.get("adapter") ?? "",
    modelLabel: params.get("model") ?? "",
    outcome: params.get("outcome") ?? "",
  });
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const facets = useQueryState(api.runs.facets);
  const experiments = useQueryState(api.experiments.list);
  const active = useQueryState(api.runs.active);
  const cursor = cursors[cursors.length - 1];
  const page = useQueryState(api.runs.list, {
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  const rerun = useMutation(api.runs.rerun);
  const canLaunch = useCan("runs.launch");
  const { fail } = useNotice();
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setCursors([]);
    setSelected(new Set());
  };

  const rows = page.data?.runs ?? [];
  const selectedRows = rows.filter((r) => selected.has(r.runId));
  const versions = new Set(selectedRows.map((r) => r.courseVersionId));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Experiment History</h1>
          <p className="muted">Every run, newest first. Rerun starts a new run from the same saved experiment revision and the same course version.</p>
        </div>
        <div className="row">
          <button className="secondary" disabled={selectedRows.length < 1 || versions.size !== 1} title={versions.size > 1 ? "Comparison needs runs of one course version" : undefined} onClick={() => go("compare", { runs: selectedRows.map((r) => r.runId).join(",") })}>
            Compare selected ({selectedRows.length})
          </button>
        </div>
      </div>
      {(active.data?.length ?? 0) > 0 && (
        <Card title="In progress" className="mb">
          <ul className="list">
            {active.data!.map((r) => (
              <li key={r.runId} className="list-row">
                <a href={href(`runs/${r.runId}`)}>{r.courseRef}</a>
                <span className="muted small">
                  {r.adapter} · {r.modelLabel}
                </span>
                <OutcomeBadge outcome={null} state={r.state === "running" && r.stage ? `running · ${r.stage}` : r.state} />
                {r.cancelRequested && <Badge tone="warn">cancel requested</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <div className="filters">
          <Field label="Course version">
            <select value={filters.courseVersionId} onChange={(e) => setFilter("courseVersionId", e.target.value)}>
              <option value="">All</option>
              {(facets.data?.courseVersions ?? []).map((v) => (
                <option key={v.courseVersionId} value={v.courseVersionId}>
                  {v.ref}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Experiment">
            <select value={filters.experimentLineageId} onChange={(e) => setFilter("experimentLineageId", e.target.value)}>
              <option value="">All</option>
              {(experiments.data ?? []).map((x) => (
                <option key={x.lineageId} value={x.lineageId}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent">
            <select value={filters.adapter} onChange={(e) => setFilter("adapter", e.target.value)}>
              <option value="">All</option>
              {(facets.data?.adapters ?? []).map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select value={filters.modelLabel} onChange={(e) => setFilter("modelLabel", e.target.value)}>
              <option value="">All</option>
              {(facets.data?.models ?? []).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Outcome">
            <select value={filters.outcome} onChange={(e) => setFilter("outcome", e.target.value)}>
              <option value="">All</option>
              {OUTCOMES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
        </div>
        {page.isLoading && !page.data ? (
          <Loading what="Loading runs" />
        ) : page.error ? (
          <ErrorBox error={page.error} />
        ) : !rows.length ? (
          <Empty title="No runs match.">
            Launch one from the <a href={href("library")}>Course Library</a>.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Select</span>
                  </th>
                  <th>Outcome</th>
                  <th>Course version</th>
                  <th>Agent · model</th>
                  <th>Acceptance</th>
                  <th>Duration</th>
                  <th>Requested</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.runId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select run ${r.runId}`}
                        checked={selected.has(r.runId)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(r.runId);
                            else next.delete(r.runId);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <OutcomeBadge outcome={r.outcome} state={r.state} />
                      {r.result?.failureClass && <span className="muted small"> {r.result.failureClass}</span>}
                    </td>
                    <td className="mono">{r.courseRef}</td>
                    <td>
                      {r.adapter} · <span className="muted">{r.modelLabel}</span>
                    </td>
                    <td>{r.result ? <Badge tone={r.result.acceptance === "pass" ? "pass" : r.result.acceptance === "fail" ? "fail" : "muted"}>{r.result.acceptance}</Badge> : <span className="muted">—</span>}</td>
                    <td>{r.result ? fmtDuration(r.result.durationMs) : <span className="muted">—</span>}</td>
                    <td className="muted small">
                      {fmtTime(r.requestedAt)} · {r.requestedBy}
                    </td>
                    <td className="row tight">
                      <a href={href(`runs/${r.runId}`)}>{r.state === "terminal" ? "Report" : "Live"}</a>
                      {canLaunch && (
                        <button className="link" onClick={() => rerun({ runId: r.runId }).then(({ runId }) => go(`runs/${runId}`)).catch(fail)}>
                          Rerun
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <button className="ghost" disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>
            ← Newer
          </button>
          <button className="ghost" disabled={!page.data?.nextCursor || page.data.exhausted} onClick={() => page.data?.nextCursor && setCursors((c) => [...c, page.data!.nextCursor!])}>
            Older →
          </button>
        </div>
      </Card>
    </div>
  );
}
