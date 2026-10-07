import { routePattern } from "../fingerprint/route.js";
import { classifyIntent } from "../agent/controls.js";
import { isDestructive } from "../agent/guards.js";
import { sqlError } from "./signatures.js";
import type { PageFacts, ProbeOutcome, RawResponse, Severity } from "./types.js";

/** The marker of parameter `i`: a tag no page has, so finding it as an element proves the value was read as markup. */
export const marker = (i: number): string => `qaxss${i}`;

/** What goes into a parameter: closes quotes and a tag, and leaves the marker. It runs no script and breaks nothing. */
export const injection = (i: number): string => `"'><${marker(i)}>`;

/** An address the application cannot reach (`.invalid` never resolves) and the runner never follows. */
export const REDIRECT_TARGET = "https://qa-redirect-check.invalid/qa";
export const EVIL_ORIGIN = "https://qa-origin-check.invalid";

const withParams = (url: string, values: string[], names: string[]): string => {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  names.forEach((n, i) => u.searchParams.set(n, values[i] ?? ""));
  return u.toString();
};

/** The address with every parameter holding its injection. */
export const injectionUrl = (url: string, params: string[]): string =>
  withParams(url, params.map((_, i) => injection(i)), params);

/** The same address with ordinary values: what the page does without the injection. */
export const benignUrl = (url: string, params: string[]): string => withParams(url, params.map(() => "1"), params);

/** A place to try the injections: an address and the parameters it takes. */
export interface Candidate {
  /** Without query or hash. */
  url: string;
  params: string[];
  /** The same route with the same parameters is one candidate, whatever the ids in it. */
  key: string;
}

const MAX_PARAMS = 5;
const TEXT_FIELDS = new Set(["text", "search", "email", "url", "tel", "textarea", ""]);

const keyOf = (url: string, params: string[]): string => `${routePattern(url)}?${[...params].sort().join(",")}`;

/**
 * A place to try, made of an address and the parameter names it takes; null when there is nothing to try or the address is
 * one the agent never touches (logout, delete).
 */
export function candidateFrom(address: string, names: string[]): Candidate | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  const params = [...new Set(names)].filter((n) => n !== "").slice(0, MAX_PARAMS);
  if (params.length === 0 || classifyIntent("", { href: u.pathname }) === "never" || isDestructive({ label: "", href: u.pathname })) return null;
  const url = u.origin + u.pathname;
  return { url, params, key: keyOf(url, params) };
}

/**
 * Where the injections can be tried on a page without changing anything: the parameters of its own address and its GET
 * forms (a search). Forms that send data, go to another site, carry a password or do something destructive are left out.
 */
export function candidatesOf(view: { url: string; security?: PageFacts | undefined }): Candidate[] {
  let page: URL;
  try {
    page = new URL(view.url);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  const add = (url: URL, names: string[]): void => {
    const c = candidateFrom(url.toString(), names);
    if (c) out.push(c);
  };
  add(page, [...page.searchParams.keys()]);
  for (const form of view.security?.forms ?? []) {
    if (form.method.toUpperCase() !== "GET" || form.password) continue;
    let action: URL;
    try {
      action = new URL(form.action, page);
    } catch {
      continue;
    }
    if (action.origin !== page.origin) continue;
    const intent = classifyIntent(form.label, { href: action.pathname });
    if (intent === "never" || intent === "delete" || intent === "external" || isDestructive({ label: form.label, href: action.pathname })) continue;
    add(
      action,
      form.fields.filter((f) => f.name !== "" && TEXT_FIELDS.has(f.type)).map((f) => f.name),
    );
  }
  return out;
}

export interface ProbeVerdict {
  /** Parameters whose marker became markup in the page. */
  xss: string[];
  /** The database that showed an error message after the injection, if one did (and not on an ordinary value too). */
  sql: string | null;
  /** The server fell over with the injection and not without it. */
  serverError: boolean;
}

/** What the page did with the injection, set against what it does with an ordinary value (`benign`, when it was asked). */
export function evaluateProbe(out: ProbeOutcome, params: string[], benign?: ProbeOutcome): ProbeVerdict {
  const xss = [...new Set(out.injected)].sort((a, b) => a - b).flatMap((i) => (params[i] !== undefined ? [params[i] as string] : []));
  const here = sqlError(out.text);
  const sql = here !== null && !(benign && sqlError(benign.text) !== null) ? here : null;
  const serverError = sql === null && benign !== undefined && out.status >= 500 && benign.status < 500;
  return { xss, sql, serverError };
}

/** Parameters that tell an application where to send the person next. */
export const isRedirectParam = (name: string): boolean =>
  /^(?:next|url|redirect|redirect_uri|redirect_url|return|return_to|returnurl|continue|dest|destination|goto|target|callback_url)$/i.test(name);

/** The response sends the person to the address we offered: any site could be put there. */
export function redirectsOutside(r: RawResponse): boolean {
  if (r.status < 300 || r.status > 399) return false;
  const location = r.headers["location"];
  if (!location) return false;
  try {
    return new URL(location, "https://app.invalid").hostname === new URL(REDIRECT_TARGET).hostname;
  } catch {
    return false;
  }
}

/** The application lets any site read its answers with the visitor's session. */
export function corsAcceptsAnyOrigin(r: RawResponse): boolean {
  const origin = r.headers["access-control-allow-origin"];
  const credentials = (r.headers["access-control-allow-credentials"] ?? "").toLowerCase() === "true";
  return credentials && (origin === EVIL_ORIGIN || origin === "*");
}

export interface SensitiveFile {
  path: string;
  severity: Severity;
  /** What makes the answer the real thing and not the application's catch-all page. */
  test: (r: RawResponse) => boolean;
}

const isHtml = (r: RawResponse): boolean => /html/i.test(r.headers["content-type"] ?? "") || /^\s*<(?:!doctype|html)/i.test(r.body);

/** Files that must never be served: each is recognised by what is inside, because many applications answer 200 to any address. */
export const SENSITIVE_FILES: SensitiveFile[] = [
  { path: "/.git/HEAD", severity: "critical", test: (r) => !isHtml(r) && /^ref: refs\/heads\//.test(r.body) },
  { path: "/.env", severity: "critical", test: (r) => !isHtml(r) && /^[A-Z][A-Z0-9_]{2,}=.+/m.test(r.body) },
  { path: "/phpinfo.php", severity: "high", test: (r) => /phpinfo\(\)|PHP Version \d/.test(r.body) },
  { path: "/server-status", severity: "high", test: (r) => /Apache Server Status|Server Version: Apache/.test(r.body) },
  { path: "/actuator/env", severity: "high", test: (r) => !isHtml(r) && /"(?:propertySources|activeProfiles)"/.test(r.body) },
  { path: "/WEB-INF/web.xml", severity: "high", test: (r) => !isHtml(r) && /<web-app/.test(r.body) },
];

export const exposedFile = (file: SensitiveFile, r: RawResponse): boolean => r.status === 200 && file.test(r);
