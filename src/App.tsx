import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useConnectionState, useMutation, useQueryState, useSession, type FeltKitClientError } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

type Notice = { tone: "error" | "info"; text: string } | null;

/** Same matching rule as AppPort: exact, "ns.*", or "*". */
function can(granted: string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}. Switch to a member to make changes.`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  if (e?.code === "CONFLICT") return e.message;
  return e?.message ?? String(error);
}

export function App() {
  const { session, signInAsDevUser, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;
  // UI hint only. The server enforces access on every call regardless of what the UI shows.
  const canWrite = can(session?.permissions ?? [], "tasks.write");
  const canComplete = can(session?.permissions ?? [], "tasks.complete");

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = (error: unknown) => setNotice({ tone: "error", text: describe(error) });

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <path d="M11 7c-4 5-4 13 0 18M21 7c4 5 4 13 0 18" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-name">Tasks</span>
          {session && <span className={`env ${session.environment.production ? "env-prod" : ""}`}>{session.environment.name}</span>}
        </div>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes from anyone appear here immediately" : "Connecting to the change stream…"}>
            <span className="dot" /> {live ? "Live" : "Connecting"}
          </span>
          {session && session.devUsers.length > 0 && (
            <label className="identity">
              <span className="sr-only">Signed in as</span>
              <select
                value={principal?.id ?? ""}
                onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())}
                aria-label="Signed in as"
              >
                <option value="">Signed out</option>
                {session.devUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.roles.join(", ")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {session?.dashboard && (
            <a className="dashboard-link" href={session.dashboard} target="_blank" rel="noreferrer">
              Dashboard ↗
            </a>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!session ? (
        <div className="center muted">Connecting…</div>
      ) : !principal ? (
        <SignedOut devUsers={session.devUsers} onSignIn={(id) => signInAsDevUser(id).catch(report)} />
      ) : (
        <Workspace canWrite={canWrite} canComplete={canComplete} role={principal.roles.join(", ")} onError={report} />
      )}

      <footer className="footer">
        Every project, task, and note lives in this app’s single FeltDB instance. Changes made by other people, agents (through AppPort), and services appear here live.
      </footer>
    </div>
  );
}

function SignedOut({ devUsers, onSignIn }: { devUsers: Array<{ id: string; name: string; roles: string[] }>; onSignIn: (id: string) => void }) {
  return (
    <div className="center">
      <div className="card narrow">
        <h1>Sign in</h1>
        {devUsers.length ? (
          <>
            <p className="muted">Development identities from feltkit/app.ts:</p>
            <div className="stack">
              {devUsers.map((u) => (
                <button key={u.id} className="secondary wide" onClick={() => onSignIn(u.id)}>
                  {u.name} <span className="muted">· {u.roles.join(", ")}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">This environment has no development sign-in. Configure auth.authenticate in feltkit/app.ts.</p>
        )}
      </div>
    </div>
  );
}

function Workspace({ canWrite, canComplete, role, onError }: { canWrite: boolean; canComplete: boolean; role: string; onError: (e: unknown) => void }) {
  const projects = useQueryState(api.projects.list);
  const [selected, setSelected] = useState<string | null>(null);
  const createProject = useMutation(api.projects.create);
  const [name, setName] = useState("");

  const list = projects.data ?? [];
  const current = useMemo(() => list.find((p) => p.id === selected) ?? list[0] ?? null, [list, selected]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const id = await createProject({ name });
      setName("");
      setSelected(id);
    } catch (error) {
      onError(error);
    }
  };

  if (projects.isLoading && !projects.data) return <div className="center muted">Loading projects…</div>;
  if (projects.error && !projects.data) return <div className="center"><div className="card narrow error-text">{describe(projects.error)}</div></div>;

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="Projects">
        <div className="sidebar-title">Projects</div>
        <nav>
          {list.map((p) => (
            <button key={p.id} className={`project ${current?.id === p.id ? "active" : ""}`} onClick={() => setSelected(p.id)}>
              <span className="project-name">{p.name}</span>
              <span className="count" title={`${p.open} open, ${p.done} done`}>
                {p.open}
              </span>
            </button>
          ))}
        </nav>
        {canWrite && (
          <form onSubmit={submit} className="new-project">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project" aria-label="New project name" maxLength={80} />
          </form>
        )}
        {!canWrite && <p className="hint">You’re signed in as a {role}. Viewers can read everything but change nothing.</p>}
      </aside>
      <main className="main">
        {current ? (
          <ProjectView key={current.id} project={current} canWrite={canWrite} canComplete={canComplete} onError={onError} />
        ) : (
          <div className="empty">
            <h1>Start your first project</h1>
            <p className="muted">Projects hold tasks. Name one in the sidebar{canWrite ? "" : " (sign in as a member)"} to begin.</p>
            {canWrite && (
              <form onSubmit={submit} className="inline-form">
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Launch plan" aria-label="Project name" />
                <button className="primary" type="submit" disabled={!name.trim()}>
                  Create project
                </button>
              </form>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

type Project = { id: string; name: string; open: number; done: number };

function ProjectView({ project, canWrite, canComplete, onError }: { project: Project; canWrite: boolean; canComplete: boolean; onError: (e: unknown) => void }) {
  const tasks = useQueryState(api.tasks.list, { projectId: project.id });
  const create = useMutation(api.tasks.create);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await create({ projectId: project.id, title });
      setTitle("");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const items = tasks.data ?? [];
  const open = items.filter((t) => !t.done).length;
  return (
    <section aria-label={project.name}>
      <div className="project-header">
        <h1>{project.name}</h1>
        <span className="muted">
          {open} open · {items.length - open} done
        </span>
      </div>
      {canWrite && (
        <form onSubmit={add} className="add-task">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task and press Enter" aria-label="New task" maxLength={200} disabled={busy} />
        </form>
      )}
      {tasks.isLoading && !tasks.data ? (
        <p className="muted pad">Loading tasks…</p>
      ) : items.length === 0 ? (
        <div className="empty small">
          <p>No tasks yet.</p>
          <p className="muted">{canWrite ? "Add one above." : "A member can add tasks."}</p>
        </div>
      ) : (
        <ul className="tasks">
          {items.map((task) => (
            <TaskRow key={task.id} task={task} canWrite={canWrite} canComplete={canComplete} open={openTask === task.id} onToggleOpen={() => setOpenTask(openTask === task.id ? null : task.id)} onError={onError} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Task = { id: string; title: string; details?: string; done: boolean; createdBy: string; completedBy?: string };

function TaskRow({ task, canWrite, canComplete, open, onToggleOpen, onError }: { task: Task; canWrite: boolean; canComplete: boolean; open: boolean; onToggleOpen: () => void; onError: (e: unknown) => void }) {
  const setDone = useMutation(api.tasks.setDone);
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [details, setDetails] = useState(task.details ?? "");

  useEffect(() => setDraft(task.title), [task.title]);
  useEffect(() => setDetails(task.details ?? ""), [task.details]);

  const save = async () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== task.title) await update({ id: task.id, title: draft }).catch(onError);
    else setDraft(task.title);
  };

  return (
    <li className={`task ${task.done ? "done" : ""} ${open ? "open" : ""}`}>
      <div className="task-row">
        <input type="checkbox" checked={task.done} disabled={!canComplete} onChange={(e) => setDone({ id: task.id, done: e.target.checked }).catch(onError)} aria-label={task.done ? "Reopen task" : "Complete task"} />
        {editing ? (
          <input
            className="title-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setDraft(task.title);
                setEditing(false);
              }
            }}
            aria-label="Task title"
          />
        ) : (
          <button className="title" onClick={onToggleOpen} onDoubleClick={() => canWrite && setEditing(true)} aria-expanded={open}>
            {task.title}
          </button>
        )}
        <span className="by muted">{task.done && task.completedBy ? `done by ${task.completedBy}` : task.createdBy}</span>
        {canWrite && !editing && (
          <button className="ghost icon" onClick={() => setEditing(true)} aria-label="Rename task" title="Rename">
            ✎
          </button>
        )}
      </div>
      {open && (
        <div className="task-detail">
          <label className="field">
            <span>Details</span>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              onBlur={() => details !== (task.details ?? "") && update({ id: task.id, details }).catch(onError)}
              placeholder={canWrite ? "Add details…" : "No details"}
              readOnly={!canWrite}
              rows={3}
              maxLength={4000}
            />
          </label>
          <Notes taskId={task.id} canWrite={canWrite} onError={onError} />
          {canWrite && (
            <div className="row-end">
              <button className="danger-link" onClick={() => remove({ id: task.id }).catch(onError)}>
                Delete task
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Notes({ taskId, canWrite, onError }: { taskId: string; canWrite: boolean; onError: (e: unknown) => void }) {
  const notes = useQueryState(api.tasks.notes, { taskId });
  const addNote = useMutation(api.tasks.addNote);
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    try {
      await addNote({ taskId, text });
      setText("");
    } catch (error) {
      onError(error);
    }
  };
  return (
    <div className="notes">
      <div className="notes-title">
        Notes <span className="muted">· stored by AppPort Services Files</span>
      </div>
      {(notes.data ?? []).map((n) => (
        <div className="note" key={n.id}>
          <div className="note-meta muted">
            {n.author} · {new Date(n.createdAt).toLocaleString()}
          </div>
          <div className="note-text">{n.text}</div>
        </div>
      ))}
      {notes.data?.length === 0 && <p className="muted small-text">No notes yet.</p>}
      {canWrite && (
        <form onSubmit={submit} className="note-form">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave a note" aria-label="New note" maxLength={8000} />
          <button className="secondary" type="submit" disabled={!text.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
