import { useEffect, useState } from "react";
import { fetchBlob } from "./api";

const MAX_CACHED = 300;
/** Pictures already fetched, by node. Flows show the same screens again and again; fetching each once is enough. */
const cache = new Map<string, string>();

function remember(id: string, url: string): void {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const old = cache.get(oldest);
      cache.delete(oldest);
      if (old) URL.revokeObjectURL(old);
    }
  }
  cache.set(id, url);
}

/** The picture of a screen, fetched with the session token (the API serves it only to signed-in users). */
export function useThumbnail(nodeId: string | undefined, available: boolean, token: string): { url: string | undefined; failed: boolean } {
  const [url, setUrl] = useState<string | undefined>(() => (nodeId ? cache.get(nodeId) : undefined));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!nodeId || !available || typeof URL.createObjectURL !== "function") {
      setUrl(undefined);
      return;
    }
    const cached = cache.get(nodeId);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    setFailed(false);
    fetchBlob(`/api/v1/nodes/${nodeId}/thumbnail`, token).then(
      (blob) => {
        if (cancelled) return;
        const made = URL.createObjectURL(blob);
        remember(nodeId, made);
        setUrl(made);
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, available, token]);
  return { url, failed };
}
