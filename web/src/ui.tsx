import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/* ---------- Toasts ---------- */

type ToastKind = "success" | "error" | "info" | "loading";
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string | undefined;
}
interface ShowOptions {
  kind?: Exclude<ToastKind, "loading">;
  title: string;
  text?: string;
  /** Milliseconds on screen; errors stay longer. */
  ms?: number;
}
export interface LoadingToast {
  done(title: string, text?: string): void;
  fail(title: string, text?: string): void;
  dismiss(): void;
}
export interface ToastApi {
  show(options: ShowOptions): void;
  /** For work that takes a while: stays up until `done`/`fail`/`dismiss`. */
  loading(title: string, text?: string): LoadingToast;
}

const NOOP_LOADING: LoadingToast = { done: () => undefined, fail: () => undefined, dismiss: () => undefined };
const ToastContext = createContext<ToastApi>({ show: () => undefined, loading: () => NOOP_LOADING });

export const useToast = (): ToastApi => useContext(ToastContext);

const TOAST_ICON: Record<ToastKind, IconName> = { success: "check", error: "alert", info: "sparkles", loading: "history" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const expireIn = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => remove(id), ms));
    },
    [remove],
  );
  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show: ({ kind = "info", title, text, ms }) => {
        const id = nextId.current++;
        setItems((prev) => [...prev.slice(-3), { id, kind, title, text }]);
        expireIn(id, ms ?? (kind === "error" ? 9000 : 5000));
      },
      loading: (title, text) => {
        const id = nextId.current++;
        setItems((prev) => [...prev.slice(-3), { id, kind: "loading", title, text }]);
        const finish = (kind: "success" | "error", t: string, tx?: string) => {
          setItems((prev) => prev.map((x) => (x.id === id ? { id, kind, title: t, text: tx } : x)));
          expireIn(id, kind === "error" ? 9000 : 5000);
        };
        return { done: (t, tx) => finish("success", t, tx), fail: (t, tx) => finish("error", t, tx), dismiss: () => remove(id) };
      },
    }),
    [expireIn, remove],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notificações" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">{t.kind === "loading" ? <span className="spinner sm" aria-hidden="true" /> : <Icon name={TOAST_ICON[t.kind]} size={18} />}</span>
            <span className="toast-body">
              <strong>{t.title}</strong>
              {t.text && <span>{t.text}</span>}
            </span>
            <button type="button" className="icon-btn" aria-label="Fechar notificação" onClick={() => remove(t.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- Modal ---------- */

export function Modal({
  title,
  subtitle,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Work in progress: the dialog cannot be dismissed. */
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop" data-testid="modal-backdrop" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="meta">{subtitle}</p>}
          </div>
          {!busy && (
            <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}

/* ---------- Small pieces ---------- */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  iconOnly = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  /** Icons with the label only for screen readers and as a tooltip. */
  iconOnly?: boolean;
}) {
  return (
    <div className={`segmented${iconOnly ? " icons" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={o.value === value ? "on" : ""} title={iconOnly ? o.label : undefined}>
          <input type="radio" name={label} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} aria-label={iconOnly ? o.label : undefined} />
          {o.icon && <Icon name={o.icon} size={iconOnly ? 16 : 15} />}
          {!iconOnly && o.label}
        </label>
      ))}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, radius = 8 }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function EmptyState({ icon, title, text, children }: { icon: IconName; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {text && <p className="meta">{text}</p>}
      {children}
    </div>
  );
}

/** The page title is already in the top bar; it is only shown again where it carries information (the greeting). */
export function PageHeader({ title, subtitle, visibleTitle = false, children }: { title: string; subtitle?: string; visibleTitle?: boolean; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h2 className={visibleTitle ? "" : "hidden"}>{title}</h2>
        {subtitle && <p className="meta">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? "Copiado" : label}
    </button>
  );
}
