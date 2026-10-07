import { createHash } from "node:crypto";
import { routePattern } from "../fingerprint/route.js";
import type { ArtifactRef } from "../protocol/schemas.js";
import type { EventSink } from "../agent/sink.js";
import type { Uploader } from "../agent/regression.js";
import { CATALOG } from "./catalog.js";
import { cookieObservations, isLocalHost, observePage, sessionSameSite, type Obs, type PageContext } from "./passive.js";
import {
  EVIL_ORIGIN,
  SENSITIVE_FILES,
  REDIRECT_TARGET,
  benignUrl,
  candidateFrom,
  candidatesOf,
  corsAcceptsAnyOrigin,
  evaluateProbe,
  exposedFile,
  injectionUrl,
  isRedirectParam,
  redirectsOutside,
  type Candidate,
} from "./probes.js";
import { sqlError } from "./signatures.js";
import type { Anchor, CookieFlag, PageFacts, SecurityCapabilities, Severity } from "./types.js";

/** What the users of one run share: the checks of the environment (not of a user) are made once. */
export interface ScanShare {
  environmentChecked: boolean;
}
export const newScanShare = (): ScanShare => ({ environmentChecked: false });

export interface ScanOptions {
  sink: EventSink;
  uploader?: Uploader | undefined;
  environment: { base_url: string; allowed_hosts: string[] };
  executor: "browser" | "mobile_web";
  /** The user being explored or tested: every step is named by it. */
  role: string;
  share: ScanShare;
  /** Addresses tried with injections per user (reads only). */
  maxProbes?: number;
}

/** How many addresses a user's session tries with injections: enough for the searches of an application, a bound for a huge one. */
export const DEFAULT_MAX_PROBES = 150;
const MAX_REDIRECT_PROBES = 10;
const MAX_ROUTES = 20;

interface Result {
  check: string;
  scope: string;
  severity: Severity;
  ok: boolean;
  /** How many times the check looked. */
  checked: number;
  /** Screens where it failed. */
  routes: string[];
  detail?: Record<string, unknown> | undefined;
  anchor: Anchor;
}

const RANK: Record<Severity, number> = { normal: 0, high: 1, critical: 2 };

/**
 * The security checks of one user's session, inside an exploration or a regression. It watches every page the run already
 * visits (headers, cookies, forms, what the page says), tries injections on the places that take parameters (reads only),
 * and at the end turns what it saw into steps: one per check and scope, failing when any observation failed.
 */
export class SecurityScan {
  private readonly results = new Map<string, Result>();
  private readonly probed = new Set<string>();
  private sameSite: PageContext["sameSite"] = "unset";
  private probes = 0;
  private redirectProbes = 0;
  private started: Anchor | undefined;
  private readonly maxProbes: number;

  constructor(private readonly o: ScanOptions) {
    this.maxProbes = o.maxProbes ?? DEFAULT_MAX_PROBES;
  }

  private context(url: string): PageContext {
    const u = new URL(url);
    return { https: u.protocol === "https:", local: isLocalHost(u.hostname), sameSite: this.sameSite };
  }

  private fold(o: Obs, route: string, anchor: Anchor): void {
    const key = `${o.check}|${o.scope}`;
    let r = this.results.get(key);
    if (!r) {
      r = { check: o.check, scope: o.scope, severity: o.severity, ok: true, checked: 0, routes: [], anchor };
      this.results.set(key, r);
    }
    r.checked++;
    if (o.ok) return;
    if (r.ok) {
      r.anchor = anchor; // the screen where it was first seen
      r.detail = o.detail;
      r.severity = o.severity;
    } else if (RANK[o.severity] > RANK[r.severity]) r.severity = o.severity;
    r.ok = false;
    if (route !== "" && !r.routes.includes(route) && r.routes.length < MAX_ROUTES) r.routes.push(route);
  }

  /**
   * What a page shows by itself: its headers, forms and text. The first time, with the session at hand, the cookies are read
   * first: whether a form without a token is exposed depends on what the session cookie says about SameSite.
   */
  page(view: { url: string; status: number; security?: PageFacts | undefined }, anchor: Anchor, route: string, caps?: SecurityCapabilities): void {
    if (caps && !this.started) {
      this.started = anchor;
      this.cookies(caps.cookieFlags?.() ?? [], anchor);
    }
    if (!view.security) return;
    for (const obs of observePage(view, this.context(view.url))) this.fold(obs, route, anchor);
  }

  /** The cookies the application set for this user, with their flags. */
  cookies(flags: CookieFlag[], anchor: Anchor): void {
    this.sameSite = sessionSameSite(flags);
    const base = new URL(this.o.environment.base_url);
    for (const obs of cookieObservations(flags, { https: base.protocol === "https:", local: isLocalHost(base.hostname) })) this.fold(obs, "", anchor);
  }

  /**
   * Tries the injections on the places of a page that take parameters: the address it was found at, its search forms and
   * what the regression remembers of it. Reads only, so it is safe under any destructive policy.
   */
  async probe(caps: SecurityCapabilities, view: { url: string; security?: PageFacts | undefined }, anchor: Anchor, route: string, known: { url: string; params: string[] }[] = []): Promise<void> {
    if (!caps.probe) return;
    const candidates = [...candidatesOf(view), ...known.flatMap((k) => candidateFrom(k.url, k.params) ?? [])];
    for (const c of candidates) {
      if (this.probes >= this.maxProbes) return;
      if (this.probed.has(c.key)) continue;
      this.probed.add(c.key);
      this.probes++;
      await this.tryInjections(caps, c, anchor);
      await this.tryRedirects(caps, c, anchor);
    }
    void route;
  }

  private async tryInjections(caps: SecurityCapabilities, c: Candidate, anchor: Anchor): Promise<void> {
    const asked = injectionUrl(c.url, c.params);
    const out = await caps.probe?.(asked).catch(() => null);
    if (!out) return;
    // the ordinary value is asked only when something looks wrong, to know whether the injection is what caused it
    const benign = out.status >= 500 || sqlError(out.text) !== null ? await caps.probe?.(benignUrl(c.url, c.params)).catch(() => null) : undefined;
    const v = evaluateProbe(out, c.params, benign ?? undefined);
    const rp = routePattern(c.url);
    for (const p of c.params) {
      const hit = v.xss.includes(p);
      this.fold({ check: "xss-reflected", scope: `${rp}?${p}`, ok: !hit, severity: "high", ...(hit ? { detail: { parameter: p, tested: asked, status: out.status, final_url: out.finalUrl } } : {}) }, rp, anchor);
    }
    const joined = [...c.params].sort().join(",");
    this.fold({ check: "sqli-error", scope: `${rp}?${joined}`, ok: v.sql === null, severity: "critical", ...(v.sql ? { detail: { engine: v.sql, tested: asked, status: out.status } } : {}) }, rp, anchor);
    this.fold({ check: "injection-500", scope: `${rp}?${joined}`, ok: !v.serverError, severity: "normal", ...(v.serverError ? { detail: { tested: asked, status: out.status } } : {}) }, rp, anchor);
  }

  private async tryRedirects(caps: SecurityCapabilities, c: Candidate, anchor: Anchor): Promise<void> {
    if (!caps.rawGet) return;
    const rp = routePattern(c.url);
    for (const p of c.params.filter(isRedirectParam)) {
      if (this.redirectProbes >= MAX_REDIRECT_PROBES) return;
      this.redirectProbes++;
      const u = new URL(c.url);
      u.searchParams.set(p, REDIRECT_TARGET);
      const resp = await caps.rawGet(u.toString()).catch(() => null);
      if (!resp) continue;
      const hit = redirectsOutside(resp);
      this.fold({ check: "open-redirect", scope: `${rp}?${p}`, ok: !hit, severity: "normal", ...(hit ? { detail: { tested: u.toString(), status: resp.status, location: resp.headers["location"] } } : {}) }, rp, anchor);
    }
  }

  /**
   * What is done once a page has been fully looked at (the injections take the browser elsewhere): the checks of the
   * environment (once for the whole run), then the injections on the page's parameters.
   */
  async after(caps: SecurityCapabilities, view: { url: string; security?: PageFacts | undefined }, anchor: Anchor, route: string, known: { url: string; params: string[] }[] = []): Promise<void> {
    if (!caps.rawGet && !caps.probe) return; // a session that can only look at pages: the page checks were all it could do
    await this.environment(caps, anchor);
    await this.probe(caps, view, anchor, route, known);
  }

  /** What belongs to the environment and not to a user: transport, CORS, files that should not be served. Made once per run. */
  async environment(caps: SecurityCapabilities, anchor: Anchor): Promise<void> {
    if (this.o.share.environmentChecked || !caps.rawGet) return;
    this.o.share.environmentChecked = true;
    const base = new URL(this.o.environment.base_url);
    if (!isLocalHost(base.hostname)) this.fold({ check: "transport-http", scope: "", ok: base.protocol === "https:", severity: "high", detail: { base_url: base.origin } }, "/", anchor);
    const cors = await caps.rawGet(base.origin + "/", { origin: EVIL_ORIGIN }).catch(() => null);
    if (cors) {
      const hit = corsAcceptsAnyOrigin(cors);
      this.fold({ check: "cors-reflect", scope: "", ok: !hit, severity: "high", ...(hit ? { detail: { allow_origin: cors.headers["access-control-allow-origin"], allow_credentials: cors.headers["access-control-allow-credentials"] } } : {}) }, "/", anchor);
    }
    for (const f of SENSITIVE_FILES) {
      const resp = await caps.rawGet(base.origin + f.path).catch(() => null);
      if (!resp) continue;
      const hit = exposedFile(f, resp);
      this.fold({ check: "exposed-file", scope: f.path, ok: !hit, severity: f.severity, ...(hit ? { detail: { status: resp.status, content_type: resp.headers["content-type"] } } : {}) }, f.path, anchor);
    }
  }

  summary(): { checks: number; failed: number; by_severity: Record<Severity, number>; probes: number } {
    const by: Record<Severity, number> = { critical: 0, high: 0, normal: 0 };
    let failed = 0;
    let checks = 0;
    for (const r of this.results.values()) {
      checks++;
      if (!r.ok) {
        failed++;
        by[r.severity]++;
      }
    }
    return { checks, failed, by_severity: by, probes: this.probes };
  }

  /** Turns what was seen into steps: failures first in the list of the run, passes so a fixed problem is seen to be fixed. */
  async finish(caps?: SecurityCapabilities): Promise<void> {
    // the cookies once more, when the application has had every chance to set them
    if (caps?.cookieFlags && this.started) this.cookies(caps.cookieFlags(), this.started);
    for (const r of this.results.values()) {
      const info = CATALOG[r.check];
      if (!info || r.checked === 0) continue;
      const key = stepKey(r.check, r.scope, this.o.role);
      const title = info.title(r.scope, r.detail);
      const scope = r.scope.slice(0, 200);
      const anchor = "fingerprint" in r.anchor ? { node_fingerprint: r.anchor.fingerprint } : { node_id: r.anchor.id };
      this.o.sink.stepStarted({
        key,
        ...anchor,
        executor: this.o.executor,
        expected: info.expected,
        input: { check: r.check, ...(r.scope ? { scope: r.scope } : {}), user: this.o.role },
        security: { check: r.check, severity: r.severity, ...(scope ? { scope } : {}) },
      });
      const artifacts = r.ok ? [] : await this.evidence(r, title);
      this.o.sink.stepFinished({
        key,
        result: r.ok ? "pass" : "fail",
        actual: r.ok ? `Sem problemas${r.checked > 1 ? ` (${r.checked} verificações)` : ""}` : title,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
    }
  }

  /** What was seen, as evidence: where, how many times, and the detail the check kept. Best effort like all evidence. */
  private async evidence(r: Result, title: string): Promise<ArtifactRef[]> {
    if (!this.o.uploader) return [];
    const body = { kind: "security", check: r.check, severity: r.severity, scope: r.scope, user: this.o.role, title, routes: r.routes, checked: r.checked, detail: r.detail ?? {} };
    try {
      return [await this.o.uploader.upload("http", "application/json", new TextEncoder().encode(JSON.stringify(body)))];
    } catch {
      return [];
    }
  }
}

/** Unique per run and user, and within what the server takes: a long scope is cut and told apart by a hash of the whole. */
function stepKey(check: string, scope: string, role: string): string {
  const full = `SEC ${check}${scope ? " " + scope : ""} @${role}`;
  if (full.length <= 190) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 160)}…${hash} @${role}`.slice(0, 190);
}
