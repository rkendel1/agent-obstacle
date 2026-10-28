import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { copy, describeError, pretty, shortDigest } from "./lib";

/* ---------- notices ---------- */

type Notice = { id: number; tone: "error" | "info" | "ok"; text: string };
const NoticeContext = createContext<{ notify: (tone: Notice["tone"], text: string) => void; fail: (e: unknown) => void }>({ notify: () => {}, fail: () => {} });

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);
  const notify = useCallback((tone: Notice["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "error" ? 9000 : 5000);
  }, []);
  const fail = useCallback((e: unknown) => notify("error", describeError(e)), [notify]);
  return (
    <NoticeContext.Provider value={{ notify, fail }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((n) => (
          <div key={n.id} className={`toast ${n.tone}`}>
            <span>{n.text}</span>
            <button className="ghost icon" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== n.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}

export const useNotice = () => useContext(NoticeContext);

/* ---------- primitives ---------- */

export function Badge({ tone = "neutral", children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

const OUTCOME_TONE: Record<string, string> = { PASS: "pass", FAIL: "fail", BLOCKED: "warn", ERROR: "error", CANCELLED: "muted" };

export function OutcomeBadge({ outcome, state }: { outcome: string | null | undefined; state?: string }) {
  if (outcome) return <Badge tone={OUTCOME_TONE[outcome] ?? "neutral"}>{outcome}</Badge>;
  return <Badge tone="info">{state ?? "pending"}</Badge>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false | undefined | "" | 0> }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map((row, i) => {
        const [k, v] = row as [ReactNode, ReactNode];
        return (
          <div key={i} className="kv-row">
            <dt>{k}</dt>
            <dd>{v === null || v === undefined || v === "" ? <span className="muted">not observed</span> : v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {what}…
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="error-box" role="alert">
      {describeError(error)}
    </div>
  );
}

/** Untrusted text (agent output, repository content): rendered as text, never as HTML. */
export function Pre({ value, max = 200_000, className = "" }: { value: unknown; max?: number; className?: string }) {
  const text = pretty(value);
  const clipped = text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)` : text;
  return <pre className={`pre ${className}`}>{clipped}</pre>;
}

export function Digest({ value }: { value: string | null | undefined }) {
  const { notify } = useNotice();
  if (!value) return <span className="muted">—</span>;
  return (
    <button className="digest" title={`${value} (click to copy)`} onClick={() => copy(value).then((ok) => ok && notify("ok", "Digest copied."))}>
      {shortDigest(value)}
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ id: T; label: ReactNode }>; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={`tab ${value === o.id ? "active" : ""}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Chips({ items, empty = "none" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return (
    <span className="chips">
      {items.map((x, i) => (
        <span key={`${x}-${i}`} className="chip">
          {x}
        </span>
      ))}
    </span>
  );
}
