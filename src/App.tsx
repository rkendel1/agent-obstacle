import { useEffect, useRef } from "react";
import { useConnectionState, useSession } from "@feltdb/feltkit/react";
import { href, useRoute, type Route } from "./lib";
import { PermissionContext } from "./perm";
import { Loading, NoticeProvider, useNotice } from "./ui";
import { Library, CourseDetail } from "./screens/Library";
import { Configure } from "./screens/Configure";
import { RunScreen } from "./screens/Run";
import { History } from "./screens/History";
import { Compare } from "./screens/Compare";
import { Builder } from "./screens/Builder";

const NAV: Array<{ route: Route["name"]; path: string; label: string; also?: Route["name"][] }> = [
  { route: "library", path: "library", label: "Courses", also: ["course"] },
  { route: "configure", path: "configure", label: "Configure" },
  { route: "history", path: "history", label: "Runs", also: ["run"] },
  { route: "compare", path: "compare", label: "Compare" },
  { route: "builder", path: "builder", label: "Builder" },
];

export function App() {
  return (
    <NoticeProvider>
      <Shell />
    </NoticeProvider>
  );
}

function Shell() {
  const { session, signInAsDevUser, signOut } = useSession();
  const live = useConnectionState();
  const route = useRoute();
  const { fail } = useNotice();
  const principal = session?.principal ?? null;

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id).catch(fail);
    }
  }, [session, principal, signInAsDevUser, fail]);

  return (
    <PermissionContext.Provider value={session?.permissions ?? []}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href={href("library")}>
          <span className="mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <path d="M4 24h6l4-10 4 10h6M7 8h3M22 8h3" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-name">Agent Obstacle Course</span>
          {session && <span className={`env ${session.environment.production ? "env-prod" : ""}`}>{session.environment.name}</span>}
        </a>
        <nav className="nav" aria-label="Screens">
          {NAV.map((n) => {
            const active = route.name === n.route || n.also?.includes(route.name);
            return (
              <a key={n.path} href={href(n.path)} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes appear here as they happen" : "Connecting to the change stream…"}>
            <span className="dot" aria-hidden /> {live ? "Live" : "Connecting"}
          </span>
          {session && session.devUsers.length > 0 && (
            <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(fail) : signOut())} aria-label="Signed in as">
              <option value="">Signed out</option>
              {session.devUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.roles.join(", ")}
                </option>
              ))}
            </select>
          )}
          {session?.dashboard && (
            <a className="subtle-link" href={session.dashboard} target="_blank" rel="noreferrer">
              Studio ↗
            </a>
          )}
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {!session ? (
          <Loading what="Connecting" />
        ) : !principal ? (
          <SignIn devUsers={session.devUsers} onSignIn={(id) => signInAsDevUser(id).catch(fail)} />
        ) : (
          <Screen route={route} />
        )}
      </main>
      <footer className="footer">
        Never a pass because the agent says so. Every run separates what the agent <b>claims</b>, what the runtime <b>observed</b>, and what the independent evaluator <b>verified</b>.
      </footer>
    </PermissionContext.Provider>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "course":
      return route.id ? <CourseDetail key={route.id} courseVersionId={route.id} /> : <Library />;
    case "configure":
      return <Configure key={route.params.toString()} params={route.params} />;
    case "run":
      return <RunScreen key={route.id} runId={route.id!} />;
    case "history":
      return <History params={route.params} />;
    case "compare":
      return <Compare params={route.params} />;
    case "builder":
      return <Builder key={route.params.toString()} params={route.params} />;
    default:
      return <Library />;
  }
}

function SignIn({ devUsers, onSignIn }: { devUsers: Array<{ id: string; name: string; roles: string[] }>; onSignIn: (id: string) => void }) {
  return (
    <div className="center">
      <div className="card narrow">
        <h1>Sign in</h1>
        {devUsers.length ? (
          <div className="stack">
            <p className="muted">Development identities:</p>
            {devUsers.map((u) => (
              <button key={u.id} className="secondary wide" onClick={() => onSignIn(u.id)}>
                {u.name} <span className="muted">· {u.roles.join(", ")}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">This environment has no development sign-in. Configure auth.authenticate in feltkit/app.ts.</p>
        )}
      </div>
    </div>
  );
}
