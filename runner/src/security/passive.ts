import { routePattern } from "../fingerprint/route.js";
import { around, bannerOf, isDirectoryListing, showsStackTrace, SQL_ERRORS, sqlError } from "./signatures.js";
import type { CookieFlag, PageFacts, Severity } from "./types.js";

/** One look at one check on one page (or cookie): it held or it did not. The scan folds many of these into findings. */
export interface Obs {
  check: string;
  /** What it looked at when narrower than the whole site: a cookie, a form, a route. */
  scope: string;
  ok: boolean;
  severity: Severity;
  detail?: Record<string, unknown>;
}

export interface PageContext {
  https: boolean;
  /** A developer's machine or a private network: plain http is normal there. */
  local: boolean;
  /** What the session cookie says about SameSite: it decides whether a form without token is exposed. */
  sameSite: "strict" | "lax" | "none" | "unset";
}

const PRIVATE_172 = /^172\.(1[6-9]|2\d|3[01])\./;

/** A developer's machine, a container host or a private network: there plain http and unsigned cookies are expected. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local") || h === "host.docker.internal" || h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || PRIVATE_172.test(h);
}

const TOKEN_FIELD = /csrf|xsrf|authenticity_token|requestverificationtoken|^_token$|anti.?forgery/i;
const SESSION_LIKE = /sess|sid\b|^sid|auth|token|jwt|login|remember/i;
/** A cookie that carries the login. The anti-CSRF cookie is meant to be read by scripts, so it is not one. */
const isSession = (name: string): boolean => SESSION_LIKE.test(name) && !/csrf|xsrf/i.test(name);

const tidy = (s: string): string => s.slice(0, 200);

/** The checks a page can answer by itself, from what the driver read. */
export function observePage(view: { url: string; status: number; security?: PageFacts | undefined }, ctx: PageContext): Obs[] {
  const f = view.security;
  if (!f) return [];
  const out: Obs[] = [];
  const add = (check: string, ok: boolean, severity: Severity, scope = "", detail?: Record<string, unknown>): void => {
    out.push({ check, scope, ok, severity, ...(detail ? { detail } : {}) });
  };

  if (f.html && view.status >= 200 && view.status < 300) {
    const h = f.headers;
    add("header-csp", Boolean(h["content-security-policy"]), "normal");
    add("header-frame", Boolean(h["x-frame-options"]) || /frame-ancestors/i.test(h["content-security-policy"] ?? ""), "normal");
    add("header-nosniff", /nosniff/i.test(h["x-content-type-options"] ?? ""), "normal");
    if (ctx.https && !ctx.local) add("header-hsts", Boolean(h["strict-transport-security"]), "normal");
    const banner = bannerOf(h);
    add("banner", banner === null, "normal", "", banner ? { banner } : undefined);
  }

  // what the page says: an error page is exactly where these show, so the status does not matter
  const stack = showsStackTrace(f.text);
  add("info-stacktrace", !stack, "high", "", stack ? { excerpt: tidy(around(f.text, /Traceback|Exception|Fatal error|Stack trace|DEBUG = True|Debugger|ActionController|Application Trace|Server Error|\bat /)) } : undefined);
  const engine = sqlError(f.text);
  add("info-sql-error", engine === null, "high", "", engine ? { engine, excerpt: tidy(around(f.text, SQL_ERRORS.find((s) => s.engine === engine)?.re ?? /SQL/i)) } : undefined);
  add("info-dirlist", !isDirectoryListing(f.text), "normal");

  if (ctx.https && !ctx.local) add("mixed-content", f.mixed.length === 0, "normal", "", f.mixed.length > 0 ? { examples: f.mixed.slice(0, 5) } : undefined);

  for (const form of f.forms) {
    const scope = `${form.method.toUpperCase()} ${routePattern(form.action)}`;
    if (form.password) {
      // a password travelling in clear text, wherever it is
      if (!ctx.local) add("password-http", form.action.startsWith("https:"), "critical", scope, form.action.startsWith("https:") ? undefined : { action: new URL(form.action).origin + new URL(form.action).pathname });
      continue; // a login or password form is not asked for the CSRF token below
    }
    if (form.method.toUpperCase() === "GET") continue; // a search changes nothing
    const hasToken = f.metaCsrf || form.hidden.some((n) => TOKEN_FIELD.test(n));
    const mitigated = ctx.sameSite === "strict" || ctx.sameSite === "lax";
    add("csrf-token", hasToken || mitigated, ctx.sameSite === "none" ? "high" : "normal", scope, hasToken ? undefined : { form: form.label, same_site: ctx.sameSite });
  }
  return out;
}

/** The flags of the cookies the application set, as findings. */
export function cookieObservations(cookies: CookieFlag[], ctx: { https: boolean; local: boolean }): Obs[] {
  const out: Obs[] = [];
  for (const c of cookies) {
    const session = isSession(c.name);
    if (session) {
      out.push({ check: "cookie-httponly", scope: c.name, ok: c.httpOnly, severity: "high" });
      out.push({ check: "cookie-samesite", scope: c.name, ok: c.sameSite === "strict" || c.sameSite === "lax", severity: "normal", detail: { same_site: c.sameSite } });
    }
    if (ctx.https && !ctx.local) out.push({ check: "cookie-secure", scope: c.name, ok: c.secure, severity: "high" });
  }
  return out;
}

/** What the session cookie says about SameSite, the strictest answer among the cookies that look like a session. */
export function sessionSameSite(cookies: CookieFlag[]): PageContext["sameSite"] {
  const mine = cookies.filter((c) => isSession(c.name));
  for (const level of ["strict", "lax", "none"] as const) if (mine.some((c) => c.sameSite === level)) return level;
  return "unset";
}
