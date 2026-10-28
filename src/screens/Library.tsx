import { useState } from "react";
import { useQueryState } from "@feltdb/feltkit/react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { api } from "../../feltkit/_generated/api";
import { fmtDuration, fmtTime, href } from "../lib";
import { useCan } from "../perm";
import { Badge, Card, Chips, Digest, Empty, ErrorBox, KV, Loading, Pre, Tabs } from "../ui";

type LibraryEntry = ResultOf<typeof api.courses.library>[number];

const KIND_TONE: Record<string, string> = { deterministic: "info", randomized: "warn", adversarial: "error" };

export function Library() {
  const library = useQueryState(api.courses.library);
  const drafts = useQueryState(api.courses.drafts);
  const canLaunch = useCan("runs.launch");
  const canDraft = useCan("courses.draft");
  const [filter, setFilter] = useState("");

  if (library.isLoading && !library.data) return <Loading what="Loading courses" />;
  if (library.error && !library.data) return <ErrorBox error={library.error} />;
  const q = filter.trim().toLowerCase();
  const list = (library.data ?? []).filter((c) => !q || [c.name, c.courseId, c.description, ...(c.latest?.skills ?? [])].join(" ").toLowerCase().includes(q));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Course Library</h1>
          <p className="muted">Immutable, versioned obstacle courses. Each run is pinned to one version and its digest.</p>
        </div>
        <div className="row">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, skill…" aria-label="Filter courses" />
          {canDraft && (
            <a className="button secondary" href={href("builder")}>
              New course
            </a>
          )}
        </div>
      </div>
      {!list.length ? (
        <Empty title={library.data?.length ? "No course matches that filter." : "No courses published yet."}>
          {!library.data?.length && (
            <>
              Publish the repository's courses with <code>npm run seed:courses</code> (as an admin, while <code>npm run dev</code> runs), or draft one in the <a href={href("builder")}>Builder</a>.
            </>
          )}
        </Empty>
      ) : (
        <div className="grid">
          {list.map((c) => (
            <CourseCard key={c.id} course={c} canLaunch={canLaunch} canDraft={canDraft} />
          ))}
        </div>
      )}
      {(drafts.data?.length ?? 0) > 0 && (
        <Card title="Drafts" className="mt">
          <ul className="list">
            {drafts.data!.map((d) => (
              <li key={d.courseVersionId} className="list-row">
                <span>
                  <b>{d.name}</b> <span className="mono muted">{d.ref}</span>
                </span>
                <span className="muted">edited by {d.createdBy} · {fmtTime(d.createdAt)}</span>
                <a href={href("builder", { draft: d.courseVersionId })}>Open in Builder</a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function CourseCard({ course, canLaunch, canDraft }: { course: LibraryEntry; canLaunch: boolean; canDraft: boolean }) {
  const v = course.latest;
  if (!v) {
    return (
      <Card title={course.name}>
        <p className="muted">{course.description}</p>
        <p className="muted">No published version yet.</p>
      </Card>
    );
  }
  return (
    <article className="card course">
      <header className="card-head">
        <h2>
          <a href={href(`course/${encodeURIComponent(v.courseVersionId)}`)}>{course.name}</a>
        </h2>
        <span className="row tight">
          <Badge tone={KIND_TONE[v.kind] ?? "neutral"}>{v.kind}</Badge>
          <Badge>{v.difficulty || "difficulty n/a"}</Badge>
        </span>
      </header>
      <p className="desc">{course.description}</p>
      <KV
        rows={[
          ["Version", <span className="mono">{v.ref}</span>],
          ["Digest", <Digest value={v.digest} />],
          ["Skills tested", <Chips items={v.skills} />],
          ["Environment", v.display.environment],
          ["Compatible configs", v.display.compatible || "any adapter / model"],
          ["Expected runtime", v.expectedRuntimeSecs ? fmtDuration(v.expectedRuntimeSecs * 1000) : null],
          ["Limits", v.display.limits],
          ["Scoring dimensions", <Chips items={v.display.scoringDimensions} />],
          ["Acceptance", v.display.acceptanceSummary || <Chips items={v.display.acceptanceChecks} />],
          course.publishedCount > 1 && ["Versions", `${course.publishedCount} published`],
        ]}
      />
      <footer className="card-foot">
        {canLaunch && (
          <a className="button primary" href={href("configure", { course: v.courseVersionId })}>
            Launch
          </a>
        )}
        <a className="button secondary" href={href(`course/${encodeURIComponent(v.courseVersionId)}`)}>
          Inspect spec
        </a>
        {canDraft && (
          <a className="button ghost" href={href("builder", { from: v.courseVersionId })}>
            Create variation
          </a>
        )}
      </footer>
    </article>
  );
}

const SECTIONS = ["identity", "objective", "environment", "capabilities", "constraints", "obstacles", "acceptance", "scoring", "evidence", "cleanup", "meta"] as const;

export function CourseDetail({ courseVersionId }: { courseVersionId: string }) {
  const version = useQueryState(api.courses.get, { courseVersionId });
  const versions = useQueryState(api.courses.versions, version.data ? { courseId: version.data.courseId } : "skip");
  const canLaunch = useCan("runs.launch");
  const canDraft = useCan("courses.draft");
  const [section, setSection] = useState<string>("all");

  if (version.isLoading && !version.data) return <Loading what="Loading course version" />;
  if (version.error && !version.data) return <ErrorBox error={version.error} />;
  const v = version.data!;
  const spec = (v.spec ?? {}) as Record<string, unknown>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <a href={href("library")}>Courses</a> / {v.name}
          </p>
          <h1>
            {v.name} <span className="mono muted small">{v.version}</span>
          </h1>
          <p className="muted">{v.description}</p>
        </div>
        <div className="row">
          {v.status === "published" && canLaunch && (
            <a className="button primary" href={href("configure", { course: v.courseVersionId })}>
              Launch
            </a>
          )}
          {v.status === "draft" && canDraft && (
            <a className="button primary" href={href("builder", { draft: v.courseVersionId })}>
              Edit draft
            </a>
          )}
          {canDraft && (
            <a className="button secondary" href={href("builder", { from: v.courseVersionId })}>
              Create variation
            </a>
          )}
          <a className="button ghost" href={href("history", { version: v.courseVersionId })}>
            Runs ({v.attempts})
          </a>
        </div>
      </div>
      <div className="split">
        <Card title="Version">
          <KV
            rows={[
              ["Status", v.status === "published" ? <Badge tone="pass">published · immutable</Badge> : <Badge tone="warn">draft</Badge>],
              ["Ref", <span className="mono">{v.ref}</span>],
              ["Digest", <Digest value={v.digest} />],
              ["Kind", v.kind],
              ["Difficulty", v.difficulty],
              ["Skills", <Chips items={v.skills} />],
              ["Expected runtime", v.expectedRuntimeSecs ? fmtDuration(v.expectedRuntimeSecs * 1000) : null],
              ["Published", v.publishedAt ? `${fmtTime(v.publishedAt)} by ${v.publishedBy}` : "not published"],
              ["Attempts", v.attempts],
              v.derivedFrom && ["Derived from", <a href={href(`course/${encodeURIComponent(v.derivedFrom)}`)}>{v.derivedFrom}</a>],
            ]}
          />
          {versions.data && versions.data.length > 1 && (
            <>
              <h3>All versions</h3>
              <ul className="list">
                {versions.data.map((x) => (
                  <li key={x.courseVersionId} className="list-row">
                    <a href={href(`course/${encodeURIComponent(x.courseVersionId)}`)} className="mono">
                      {x.version}
                    </a>
                    <Badge tone={x.status === "published" ? "pass" : "warn"}>{x.status}</Badge>
                    <Digest value={x.digest} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card title="Specification" actions={<Tabs label="Section" value={section} onChange={setSection} options={[{ id: "all", label: "All" }, ...SECTIONS.filter((s) => s in spec).map((s) => ({ id: s, label: s }))]} />}>
          <p className="muted small">The course document exactly as published (evaluator files are never sent to the app).</p>
          <Pre value={section === "all" ? spec : spec[section]} className="tall" />
        </Card>
      </div>
    </div>
  );
}
