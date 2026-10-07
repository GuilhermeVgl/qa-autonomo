/**
 * Is the application there at all? A failure to load a page is a bug in the page unless the whole application is gone, and
 * then it is one problem, not one per page: runs stop and say so instead of reporting everything as broken.
 */

const INFRA = /ERR_(?:CONNECTION_(?:REFUSED|RESET|CLOSED|TIMED_OUT|ABORTED)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT|EMPTY_RESPONSE|SSL_|CERT_|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i;

/** An error from the browser or the network that says the application could not be reached. */
export const isInfraMessage = (message: string): boolean => INFRA.test(message);

/** What a proxy answers when the application behind it is not there. */
export const isGatewayStatus = (status: number): boolean => status === 502 || status === 503 || status === 504;

export interface Reach {
  up: boolean;
  detail: string;
}

const REASONS: Record<string, string> = {
  ECONNREFUSED: "conexão recusada (ECONNREFUSED)",
  ENOTFOUND: "endereço não encontrado (ENOTFOUND)",
  EAI_AGAIN: "endereço não encontrado (EAI_AGAIN)",
  ETIMEDOUT: "tempo esgotado (ETIMEDOUT)",
  ECONNRESET: "conexão interrompida (ECONNRESET)",
  EHOSTUNREACH: "servidor inalcançável (EHOSTUNREACH)",
  ENETUNREACH: "rede inalcançável (ENETUNREACH)",
};

/** One plain GET of the application's address from the runner, without following redirects. */
export async function reachable(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<Reach> {
  try {
    const res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return isGatewayStatus(res.status) ? { up: false, detail: `o servidor respondeu HTTP ${res.status}` } : { up: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    const code = String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code ?? "");
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { up: false, detail: REASONS[code] ?? (timedOut ? "não respondeu a tempo" : code || (err instanceof Error ? err.message : String(err))) };
  }
}

/** Down only when every try says so: one hiccup is not an outage. */
export async function confirmDown(url: string, opts: { fetchFn?: typeof fetch; attempts?: number; gapMs?: number } = {}): Promise<{ down: boolean; detail: string }> {
  const attempts = opts.attempts ?? 2;
  let detail = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && (opts.gapMs ?? 1500) > 0) await new Promise((r) => setTimeout(r, opts.gapMs ?? 1500));
    const r = await reachable(url, opts.fetchFn);
    if (r.up) return { down: false, detail: r.detail };
    detail = r.detail;
  }
  return { down: true, detail };
}
