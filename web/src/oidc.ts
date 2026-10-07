// OIDC authorization-code flow with PKCE for the SPA. The control plane validates the resulting id_token
// (signature, issuer, audience, expiry); the browser only checks state, nonce and expiry, which are its job.

const KEY = "qa_oidc";
const SCOPES = "openid profile email";

export interface OidcConfig {
  issuer: string;
  clientId: string;
}

export interface OidcDeps {
  fetch: typeof fetch;
  storage: Storage;
  origin: string;
  redirect: (url: string) => void;
  replaceUrl: (url: string) => void;
  now: () => number;
  random: () => string;
}

export function browserDeps(): OidcDeps {
  return {
    fetch: (...a) => fetch(...a),
    storage: sessionStorage,
    origin: window.location.origin,
    redirect: (u) => window.location.assign(u),
    replaceUrl: (u) => window.history.replaceState(null, "", u),
    now: () => Date.now(),
    random: () => base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function buildAuthUrl(endpoint: string, clientId: string, redirectUri: string, state: string, nonce: string, challenge: string): string {
  const u = new URL(endpoint);
  u.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

async function discover(issuer: string, d: OidcDeps): Promise<Discovery> {
  const res = await d.fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error("OIDC discovery document is incomplete");
  return { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint };
}

/** Starts the sign-in: stores the one-time secrets for this tab and redirects to the provider. */
export async function startLogin(config: OidcConfig, d: OidcDeps): Promise<void> {
  const endpoints = await discover(config.issuer, d);
  const verifier = d.random();
  const state = d.random();
  const nonce = d.random();
  d.storage.setItem(KEY, JSON.stringify({ verifier, state, nonce }));
  d.redirect(buildAuthUrl(endpoints.authorization_endpoint, config.clientId, `${d.origin}/`, state, nonce, await pkceChallenge(verifier)));
}

function payloadOf(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isExpired(token: string, now: () => number = Date.now): boolean {
  if (token.startsWith("dev:")) return false;
  const exp = payloadOf(token)?.["exp"];
  return typeof exp !== "number" || exp * 1000 <= now();
}

/** Finishes the sign-in when the URL is the provider's callback. Returns the id_token, or null if it is not a callback. */
export async function completeLogin(search: string, config: OidcConfig, d: OidcDeps): Promise<string | null> {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) throw new Error(`${error}: ${params.get("error_description") ?? ""}`.trim());
  const code = params.get("code");
  if (!code) return null;

  const stored = d.storage.getItem(KEY);
  d.storage.removeItem(KEY); // single use, whatever happens next
  if (!stored) throw new Error("No sign-in in progress in this browser");
  const { verifier, state, nonce } = JSON.parse(stored) as { verifier: string; state: string; nonce: string };
  if (params.get("state") !== state) throw new Error("OIDC state mismatch");

  const endpoints = await discover(config.issuer, d);
  const res = await d.fetch(endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${d.origin}/`,
      client_id: config.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const idToken = ((await res.json()) as { id_token?: string }).id_token;
  if (!idToken) throw new Error("Provider returned no id_token");
  const claims = payloadOf(idToken);
  if (!claims || claims["nonce"] !== nonce) throw new Error("OIDC nonce mismatch");
  if (isExpired(idToken, d.now)) throw new Error("id_token already expired");
  d.replaceUrl("/");
  return idToken;
}
