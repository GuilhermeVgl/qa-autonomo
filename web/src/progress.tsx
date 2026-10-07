import { useEffect, useRef, useState } from "react";
import type { Run } from "./api";

/** "1:05" for 65 seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Re-renders the component every `intervalMs` so clocks and "fresh" markers keep moving. */
export function useTicker(intervalMs = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

export interface Discovery {
  id: string;
  label: string;
  at: number;
}

const FRESH_MS = 6000;
const FEED_LIMIT = 40;

/**
 * Turns graph updates into a feed of "new screen" items. Whatever a graph already had when we first saw it is not
 * news; a new graph version (a new exploration) starts the feed over. `freshIds` are the screens found in the last
 * few seconds, to highlight them on the canvas.
 */
export function useDiscoveries(graphId: string | undefined, nodes: { id: string; label: string }[] | undefined) {
  useTicker();
  const known = useRef<{ graphId: string | undefined; ids: Set<string> }>({ graphId: undefined, ids: new Set() });
  const [items, setItems] = useState<Discovery[]>([]);

  useEffect(() => {
    if (!nodes) return;
    if (known.current.graphId !== graphId) {
      known.current = { graphId, ids: new Set(nodes.map((n) => n.id)) };
      setItems([]);
      return;
    }
    const added = nodes.filter((n) => !known.current.ids.has(n.id));
    if (added.length === 0) return;
    for (const n of added) known.current.ids.add(n.id);
    const at = Date.now();
    setItems((prev) => [...added.map((n) => ({ id: n.id, label: n.label, at })).reverse(), ...prev].slice(0, FEED_LIMIT));
  }, [graphId, nodes]);

  const now = Date.now();
  return { items, freshIds: new Set(items.filter((i) => now - i.at < FRESH_MS).map((i) => i.id)) };
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 4) return "agora";
  return s < 60 ? `há ${s} s` : `há ${Math.floor(s / 60)} min`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** What the agent is doing right now: numbers against the run budget and a feed of what it just found. */
export function RunProgress({ run, nodes, edges, items }: { run: Run; nodes: number; edges: number; items: Discovery[] }) {
  useTicker();
  const now = Date.now();
  const exploring = run.type === "exploration";
  const queued = run.status === "queued";
  const since = Date.parse((queued ? run.created_at : run.started_at) ?? "") || now;
  const elapsed = (now - since) / 1000;
  const maxPages = run.budget?.max_pages ?? 0;
  const maxSeconds = run.budget?.max_seconds ?? 0;
  const title = queued ? "Na fila" : exploring ? "Mapeando a aplicação" : "Executando a regressão";

  return (
    <section aria-label="Andamento do run" className="card progress">
      <div className="card-head">
        <h2>
          {!queued && <span className="live-dot" aria-hidden="true" />}
          {title}
        </h2>
        <span className="clock">{formatClock(elapsed)}</span>
      </div>
      {queued && <p className="meta">Aguardando um runner disponível. Se demorar, confira se o runner está de pé.</p>}
      {!queued && exploring && (
        <>
          <p className="stat">
            <strong>
              {nodes} {plural(nodes, "tela mapeada", "telas mapeadas")}
            </strong>
            {maxPages > 0 && <span className="meta"> de até {maxPages}</span>}
          </p>
          <Bar label="Telas mapeadas" value={nodes} max={maxPages} />
          <p className="meta">
            {edges} {plural(edges, "ligação", "ligações")}
            {maxSeconds > 0 && (
              <>
                {" · limite de tempo "}
                <span>{formatClock(maxSeconds)}</span>
              </>
            )}
          </p>
          {items.length === 0 ? (
            <p className="meta">Aguardando a primeira tela…</p>
          ) : (
            <ol className="feed" aria-label="Descobertas">
              {items.slice(0, 8).map((i) => (
                <li key={i.id}>
                  <span className="feed-label">{i.label}</span>
                  <span className="meta">{ago(i.at, now)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {!queued && !exploring && <p className="meta">Revisitando os nós cobertos e conferindo o resultado de cada um.</p>}
    </section>
  );
}
