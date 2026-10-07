import { describe, expect, it } from "vitest";
import { cookieObservations, isLocalHost, observePage, sessionSameSite, type Obs } from "./passive.js";
import type { CookieFlag, PageFacts } from "./types.js";

const goodHeaders = {
  "content-security-policy": "default-src 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
};
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ headers: goodHeaders, html: true, forms: [], metaCsrf: false, mixed: [], text: "Pedidos", ...over });
const ctx = { https: true, local: false, sameSite: "lax" as const };
const view = (f: PageFacts, status = 200) => ({ url: "https://app.test/orders", status, security: f });
const by = (obs: Obs[], check: string, scope = "") => obs.find((o) => o.check === check && o.scope === scope);

describe("observePage: headers", () => {
  it("is all fine for a page with the usual protections", () => {
    const obs = observePage(view(facts()), ctx);
    expect(obs.filter((o) => !o.ok)).toEqual([]);
    expect(by(obs, "header-csp")?.ok).toBe(true);
  });

  it("notes each protection that is missing", () => {
    const obs = observePage(view(facts({ headers: {} })), ctx);
    for (const check of ["header-csp", "header-frame", "header-nosniff", "header-hsts"]) expect(by(obs, check)?.ok, check).toBe(false);
  });

  it("takes frame-ancestors in the CSP as protection against clickjacking, and a report-only CSP as no CSP", () => {
    const withAncestors = observePage(view(facts({ headers: { "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff", "strict-transport-security": "x" } })), ctx);
    expect(by(withAncestors, "header-frame")?.ok).toBe(true);
    const reportOnly = observePage(view(facts({ headers: { "content-security-policy-report-only": "default-src 'self'" } })), ctx);
    expect(by(reportOnly, "header-csp")?.ok).toBe(false);
  });

  it("asks for HSTS only over https and away from a developer's machine", () => {
    expect(by(observePage(view(facts({ headers: {} })), { ...ctx, https: false }), "header-hsts")).toBeUndefined();
    expect(by(observePage(view(facts({ headers: {} })), { ...ctx, local: true }), "header-hsts")).toBeUndefined();
  });

  it("looks at headers only on HTML pages that answered, never on an error page or a file", () => {
    expect(observePage(view(facts({ headers: {}, html: false })), ctx).some((o) => o.check.startsWith("header-"))).toBe(false);
    expect(observePage(view(facts({ headers: {} }), 500), ctx).some((o) => o.check.startsWith("header-"))).toBe(false);
  });

  it("notes a server that tells its version", () => {
    const obs = observePage(view(facts({ headers: { ...goodHeaders, server: "nginx/1.18.0", "x-powered-by": "PHP/7.4.3" } })), ctx);
    const b = by(obs, "banner");
    expect(b?.ok).toBe(false);
    expect(JSON.stringify(b?.detail)).toContain("nginx/1.18.0");
    expect(by(observePage(view(facts()), ctx), "banner")?.ok).toBe(true);
  });
});

describe("observePage: what the page says", () => {
  it("notes a stack trace, an SQL error and a directory listing, whatever the status", () => {
    const trace = observePage(view(facts({ text: "Traceback (most recent call last):\n File x" }), 500), ctx);
    expect(by(trace, "info-stacktrace")?.ok).toBe(false);
    const sql = observePage(view(facts({ text: "You have an error in your SQL syntax near ''" })), ctx);
    expect(by(sql, "info-sql-error")?.ok).toBe(false);
    expect(JSON.stringify(by(sql, "info-sql-error")?.detail)).toContain("MySQL");
    const dir = observePage(view(facts({ text: "Index of /backups\nParent Directory\nName Last modified Size" })), ctx);
    expect(by(dir, "info-dirlist")?.ok).toBe(false);
  });

  it("is clean for an ordinary page", () => {
    const obs = observePage(view(facts()), ctx);
    for (const c of ["info-stacktrace", "info-sql-error", "info-dirlist"]) expect(by(obs, c)?.ok, c).toBe(true);
  });

  it("notes an https page that loads things over http", () => {
    const obs = observePage(view(facts({ mixed: ["http://cdn.test/a.js"] })), ctx);
    expect(by(obs, "mixed-content")?.ok).toBe(false);
    expect(by(observePage(view(facts({ mixed: ["http://cdn.test/a.js"] })), { ...ctx, https: false }), "mixed-content")).toBeUndefined();
  });
});

describe("observePage: forms and CSRF", () => {
  const form = (over: Partial<PageFacts["forms"][number]> = {}) => ({ method: "POST", action: "https://app.test/orders", label: "Novo", hidden: [], fields: [{ name: "name", type: "text" }], password: false, ...over });

  it("asks a form that changes data for a token, and takes the usual names as one", () => {
    const missing = observePage(view(facts({ forms: [form()] })), { ...ctx, sameSite: "unset" });
    const o = by(missing, "csrf-token", "POST /orders");
    expect(o?.ok).toBe(false);
    expect(o?.severity).toBe("normal"); // only the browser's default SameSite stands in the way
    for (const name of ["authenticity_token", "csrf_token", "_csrf", "csrfmiddlewaretoken", "__RequestVerificationToken", "XSRF-TOKEN", "_token"]) {
      expect(by(observePage(view(facts({ forms: [form({ hidden: [name] })] })), ctx), "csrf-token", "POST /orders")?.ok, name).toBe(true);
    }
  });

  it("takes the page's csrf meta tag as the token, as Rails and Laravel do", () => {
    expect(by(observePage(view(facts({ metaCsrf: true, forms: [form()] })), ctx), "csrf-token", "POST /orders")?.ok).toBe(true);
  });

  it("is not a problem when the session cookie is SameSite Lax or Strict: the browser does not send it from another site", () => {
    for (const sameSite of ["lax", "strict"] as const) expect(by(observePage(view(facts({ forms: [form()] })), { ...ctx, sameSite }), "csrf-token", "POST /orders")?.ok).toBe(true);
  });

  it("is serious when the cookie is SameSite=None and the form has no token", () => {
    const o = by(observePage(view(facts({ forms: [form()] })), { ...ctx, sameSite: "none" }), "csrf-token", "POST /orders");
    expect(o?.ok).toBe(false);
    expect(o?.severity).toBe("high");
  });

  it("does not ask a search form, nor a login form, for a token", () => {
    const obs = observePage(view(facts({ forms: [form({ method: "GET", action: "https://app.test/search" }), form({ action: "https://app.test/login", password: true })] })), { ...ctx, sameSite: "none" });
    expect(obs.some((o) => o.check === "csrf-token")).toBe(false);
  });

  it("notes a password sent without https, but not on a developer's machine", () => {
    const f = facts({ forms: [form({ action: "http://app.test/login", password: true })] });
    expect(by(observePage(view(f), { https: false, local: false, sameSite: "lax" }), "password-http", "POST /login")?.ok).toBe(false);
    expect(by(observePage(view(f), { https: false, local: true, sameSite: "lax" }), "password-http")).toBeUndefined();
    expect(by(observePage(view(facts({ forms: [form({ action: "https://app.test/login", password: true })] })), ctx), "password-http", "POST /login")?.ok).toBe(true);
  });

  it("names the form by its route pattern, so /orders/1 and /orders/2 are one finding", () => {
    const obs = observePage(view(facts({ forms: [form({ action: "https://app.test/orders/17/items" }), form({ action: "https://app.test/orders/18/items" })] })), { ...ctx, sameSite: "unset" });
    expect(obs.filter((o) => o.check === "csrf-token").map((o) => o.scope)).toEqual(["POST /orders/:id/items", "POST /orders/:id/items"]);
  });
});

describe("cookieObservations and sessionSameSite", () => {
  const cookie = (over: Partial<CookieFlag>): CookieFlag => ({ name: "_app_session", httpOnly: true, secure: true, sameSite: "lax", ...over });

  it("is fine for a session cookie with all the flags", () => {
    expect(cookieObservations([cookie({})], { https: true, local: false }).every((o) => o.ok)).toBe(true);
  });

  it("notes the flag a session cookie lacks, named by the cookie", () => {
    const obs = cookieObservations([cookie({ httpOnly: false, secure: false, sameSite: "unset" })], { https: true, local: false });
    expect(by(obs, "cookie-httponly", "_app_session")).toMatchObject({ ok: false, severity: "high" });
    expect(by(obs, "cookie-secure", "_app_session")).toMatchObject({ ok: false, severity: "high" });
    expect(by(obs, "cookie-samesite", "_app_session")?.ok).toBe(false);
  });

  it("asks HttpOnly and SameSite only of cookies that look like a session, and Secure only over https away from home", () => {
    const theme = cookie({ name: "theme", httpOnly: false, secure: false, sameSite: "unset" });
    const obs = cookieObservations([theme], { https: true, local: false });
    expect(obs.map((o) => o.check)).toEqual(["cookie-secure"]);
    expect(cookieObservations([theme], { https: false, local: false })).toEqual([]);
    expect(cookieObservations([theme], { https: true, local: true })).toEqual([]);
  });

  it("does not ask the anti-CSRF cookie to hide from scripts: they are meant to read it", () => {
    expect(cookieObservations([cookie({ name: "XSRF-TOKEN", httpOnly: false })], { https: true, local: false }).map((o) => o.check)).toEqual(["cookie-secure"]);
  });

  it("reads SameSite of the session cookie for the CSRF check", () => {
    expect(sessionSameSite([cookie({ sameSite: "strict" })])).toBe("strict");
    expect(sessionSameSite([cookie({ sameSite: "none" }), cookie({ name: "sid", sameSite: "lax" })])).toBe("lax");
    expect(sessionSameSite([cookie({ sameSite: "unset" })])).toBe("unset");
    expect(sessionSameSite([cookie({ name: "theme", sameSite: "none" })])).toBe("unset"); // not a session cookie: says nothing
    expect(sessionSameSite([])).toBe("unset");
  });
});

describe("isLocalHost", () => {
  it("knows a developer's machine and private networks", () => {
    for (const h of ["localhost", "127.0.0.1", "host.docker.internal", "app.local", "10.1.2.3", "192.168.0.5", "172.20.1.1", "[::1]", "::1"]) expect(isLocalHost(h), h).toBe(true);
    for (const h of ["app.kpmg.com", "8.8.8.8", "172.32.0.1", "example.org"]) expect(isLocalHost(h), h).toBe(false);
  });
});
