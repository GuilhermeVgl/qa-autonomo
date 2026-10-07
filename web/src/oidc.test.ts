import { describe, expect, it } from "vitest";
import { buildAuthUrl, completeLogin, isExpired, pkceChallenge, startLogin, type OidcDeps } from "./oidc";

const discovery = { authorization_endpoint: "https://idp.test/authorize", token_endpoint: "https://idp.test/token" };
const config = { issuer: "https://idp.test/tenant/v2.0", clientId: "client-1" };

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function deps(over: Partial<OidcDeps> = {}): OidcDeps & { assigned: string[]; replaced: string[]; requests: { url: string; body: string }[] } {
  const assigned: string[] = [];
  const replaced: string[] = [];
  const requests: { url: string; body: string }[] = [];
  const base: OidcDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify(discovery));
      return new Response(JSON.stringify({ id_token: jwt({ nonce: "RAND", exp: Math.floor(Date.now() / 1000) + 3600, email: "a@x.com" }) }));
    }) as unknown as typeof fetch,
    storage: memoryStorage(),
    origin: "https://qa.test",
    redirect: (u) => assigned.push(u),
    replaceUrl: (u) => replaced.push(u),
    now: () => Date.now(),
    random: () => "RAND",
  };
  return Object.assign({ ...base, ...over }, { assigned, replaced, requests });
}

describe("pkceChallenge", () => {
  it("matches the RFC 7636 test vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("buildAuthUrl", () => {
  it("builds an authorization-code + PKCE request", () => {
    const u = new URL(buildAuthUrl(discovery.authorization_endpoint, "client-1", "https://qa.test/", "STATE", "NONCE", "CHAL"));
    expect(u.origin + u.pathname).toBe("https://idp.test/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "client-1",
      response_type: "code",
      redirect_uri: "https://qa.test/",
      scope: "openid profile email",
      state: "STATE",
      nonce: "NONCE",
      code_challenge: "CHAL",
      code_challenge_method: "S256",
    });
  });
});

describe("startLogin", () => {
  it("discovers the provider, stores the PKCE secrets and redirects", async () => {
    const d = deps();
    await startLogin(config, d);
    expect(d.requests[0]?.url).toBe("https://idp.test/tenant/v2.0/.well-known/openid-configuration");
    expect(d.assigned).toHaveLength(1);
    const u = new URL(d.assigned[0] as string);
    expect(u.searchParams.get("state")).toBe("RAND");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.storage.getItem("qa_oidc")).not.toBeNull();
  });
});

describe("completeLogin", () => {
  async function started() {
    const d = deps();
    await startLogin(config, d);
    return d;
  }

  it("returns null when the URL is not an OIDC callback", async () => {
    expect(await completeLogin("", config, deps())).toBeNull();
    expect(await completeLogin("?foo=bar", config, deps())).toBeNull();
  });

  it("exchanges the code (with the PKCE verifier) for an id_token and cleans the URL", async () => {
    const d = await started();
    const token = await completeLogin("?code=CODE&state=RAND", config, { ...d, random: () => "RAND" });
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.sig$/);
    const exchange = d.requests.find((r) => r.url === discovery.token_endpoint);
    const form = new URLSearchParams(exchange?.body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "CODE", client_id: "client-1", redirect_uri: "https://qa.test/" });
    expect(form.get("code_verifier")).toBe("RAND");
    expect(d.replaced).toEqual(["/"]);
    expect(d.storage.getItem("qa_oidc")).toBeNull(); // one-time secrets are gone
  });

  it("rejects a callback whose state does not match (CSRF)", async () => {
    const d = await started();
    await expect(completeLogin("?code=CODE&state=OTHER", config, d)).rejects.toThrow(/state/);
  });

  it("rejects when nothing was started in this browser", async () => {
    await expect(completeLogin("?code=CODE&state=RAND", config, deps())).rejects.toThrow();
  });

  it("rejects an id_token with the wrong nonce or already expired", async () => {
    const d = await started();
    const badNonce = {
      ...d,
      fetch: (async (url: string) =>
        new Response(JSON.stringify(url.endsWith("openid-configuration") ? discovery : { id_token: jwt({ nonce: "EVIL", exp: 9999999999 }) }))) as unknown as typeof fetch,
    };
    await expect(completeLogin("?code=C&state=RAND", config, badNonce)).rejects.toThrow(/nonce/);

    const d2 = await started();
    const expired = {
      ...d2,
      fetch: (async (url: string) =>
        new Response(JSON.stringify(url.endsWith("openid-configuration") ? discovery : { id_token: jwt({ nonce: "RAND", exp: 1 }) }))) as unknown as typeof fetch,
    };
    await expect(completeLogin("?code=C&state=RAND", config, expired)).rejects.toThrow(/expir/);
  });

  it("surfaces provider errors from the callback", async () => {
    await expect(completeLogin("?error=access_denied&error_description=nope", config, deps())).rejects.toThrow(/access_denied/);
  });
});

describe("isExpired", () => {
  it("never expires dev tokens, expires old JWTs, keeps fresh ones", () => {
    const now = () => 1_000_000_000_000;
    expect(isExpired("dev:ana@x.com", now)).toBe(false);
    expect(isExpired(jwt({ exp: 1_000_000_000 - 10 }), now)).toBe(true);
    expect(isExpired(jwt({ exp: 1_000_000_000 + 600 }), now)).toBe(false);
    expect(isExpired("garbage", now)).toBe(true);
  });
});
