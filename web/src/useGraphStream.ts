import { useEffect } from "react";
import { streamEvents } from "./sse";

const RECONNECT_MS = 2000;

/** Calls onChange whenever the server reports the graph changed; reconnects if the stream drops. */
export function useGraphStream(graphId: string | undefined, token: string, onChange: () => void): void {
  useEffect(() => {
    if (!graphId) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = (): void => {
      streamEvents(`/api/v1/graphs/${graphId}/stream`, token, (e) => e.event === "graph_changed" && onChange(), ctrl.signal)
        .catch(() => undefined)
        .finally(() => {
          if (!ctrl.signal.aborted) timer = setTimeout(connect, RECONNECT_MS);
        });
    };
    connect();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [graphId, token, onChange]);
}
