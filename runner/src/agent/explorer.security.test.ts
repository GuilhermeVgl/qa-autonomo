import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../protocol/schemas.js";
import { injection } from "../security/probes.js";
import type { CookieFlag, PageFacts, ProbeOutcome, RawResponse } from "../security/types.js";
import { explore, type Driver, type PageView, type Session } from "./explorer.js";
import { EventSink } from "./sink.js";

const BASE = "https://app.test";
const good = { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "strict-transport-security": "x" };
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ headers: good, html: true, forms: [], metaCsrf: false, mixed: [], text: "ok", ...over });

interface Page {
  sig: string;
  links?: string[];
  facts?: PageFacts;
}

class SecDriver implements Driver {
  visits: { role: string; url: string; security: boolean }[] = [];
  probed: string[] = [];
  raws: string[] = [];
  constructor(
    private readonly site: Record<string, Page>,
    private readonly opts: { cookies?: CookieFlag[]; probe?: (u: URL) => Partial<ProbeOutcome>; raw?: (u: URL) => Partial<RawResponse> } = {},
  ) {}
  async newSession(role: string): Promise<Session | null> {
    return {
      visit: async (url: string, o?: { security?: boolean }): Promise<PageView> => {
        const path = new URL(url).pathname;
        this.visits.push({ role, url, security: o?.security === true });
        const p = this.site[path] ?? { sig: "404" };
        return {
          url,
          status: this.site[path] ? 200 : 404,
          domSignature: p.sig,
          links: (p.links ?? []).map((h) => ({ href: new URL(h, BASE).toString(), label: "link" })),
          ...(o?.security ? { security: p.facts ?? facts() } : {}),
        };
      },
      cookieFlags: () => this.opts.cookies ?? [],
      probe: async (u: string): Promise<ProbeOutcome> => {
        this.probed.push(u);
        return { status: 200, finalUrl: u, injected: [], text: "Resultados", ...this.opts.probe?.(new URL(u)) };
      },
      rawGet: async (u: string): Promise<RawResponse> => {
        this.raws.push(u);
        return { status: 404, headers: {}, body: "", ...this.opts.raw?.(new URL(u)) };
      },
      close: async () => {},
    };
  }
}

const budget = { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 };

async function run(driver: Driver, opts: { creds?: string[]; budget?: Partial<typeof budget & { no_security: boolean }> } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await explore({
    driver,
    sink,
    environment: { base_url: BASE + "/", allowed_hosts: ["app.test"], destructive_policy: "block" },
    credentials: (opts.creds ?? ["admin"]).map((r) => ({ app_role: r, kind: "login" as const, payload: { username: "u", password: "p" } })),
    budget: { ...budget, ...opts.budget },
    shouldStop: () => false,
  });
  await sink.flush();
  const nodes = events.flatMap((e) => (e.type === "node_discovered" ? [e.payload] : []));
  const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
  const finished = new Map(events.flatMap((e) => (e.type === "step_finished" ? [[e.payload.key, e.payload] as const] : [])));
  const steps = started.map((s) => ({ ...s, ...finished.get(s.key) }));
  return { summary, nodes, steps, events };
}

const site: Record<string, Page> = {
  "/": { sig: "home", links: ["/orders", "/search?q=x"] },
  "/orders": { sig: "orders", facts: facts({ headers: {} }) },
  "/search": { sig: "search" },
};

describe("exploration with security checks", () => {
  it("turns what the pages lack into steps on the screens, after the screens exist", async () => {
    const { steps, events } = await run(new SecDriver(site));
    const csp = steps.find((s) => s.security?.check === "header-csp");
    expect(csp).toMatchObject({ result: "fail", node_fingerprint: expect.any(String), security: { severity: "normal" } });
    // a step can only hang on a screen the server already knows
    const nodeIdx = events.findIndex((e) => e.type === "node_discovered" && e.payload.fingerprint === csp?.node_fingerprint);
    const stepIdx = events.findIndex((e) => e.type === "step_started" && e.payload.key === csp?.key);
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    expect(stepIdx).toBeGreaterThan(nodeIdx);
  });

  it("asks the visits to read what the checks need", async () => {
    const d = new SecDriver(site);
    await run(d);
    expect(d.visits.every((v) => v.security)).toBe(true);
  });

  it("tries the injections on the search the home page links to, once, and says what it found", async () => {
    const d = new SecDriver(site, { probe: (u) => ({ injected: u.pathname === "/search" && u.searchParams.get("q") === injection(0) ? [0] : [] }) });
    const { steps } = await run(d);
    expect(d.probed).toHaveLength(1);
    expect(steps.find((s) => s.security?.check === "xss-reflected")).toMatchObject({ result: "fail", security: { scope: "/search?q", severity: "high" } });
  });

  it("remembers the parameters a page was found with, never their values", async () => {
    const { nodes } = await run(new SecDriver(site));
    const meta = nodes.find((n) => n.label === "/search")?.metadata as { query?: string[]; url?: string };
    expect(meta.query).toEqual(["q"]);
    expect(JSON.stringify(nodes)).not.toContain("q=x");
  });

  it("checks the environment once for all the users, and each user's findings are their own", async () => {
    const d = new SecDriver(site);
    const { steps } = await run(d, { creds: ["admin", "operador"] });
    expect(d.raws.filter((u) => u.endsWith("/.env"))).toHaveLength(1);
    const csp = steps.filter((s) => s.security?.check === "header-csp").map((s) => s.key);
    expect(csp.sort()).toEqual(["SEC header-csp @admin", "SEC header-csp @operador"]);
  });

  it("reads the cookies of the session: a session cookie without HttpOnly is a finding", async () => {
    const { steps } = await run(new SecDriver(site, { cookies: [{ name: "_session", httpOnly: false, secure: true, sameSite: "lax" }] }));
    expect(steps.find((s) => s.security?.check === "cookie-httponly")).toMatchObject({ result: "fail", security: { scope: "_session" } });
  });

  it("keeps the findings out of the way when asked: no reading, no probes, no steps", async () => {
    const d = new SecDriver(site);
    const { steps, summary } = await run(d, { budget: { no_security: true } });
    expect(steps).toEqual([]);
    expect(d.probed).toEqual([]);
    expect(d.raws).toEqual([]);
    expect(d.visits.every((v) => !v.security)).toBe(true);
    expect(summary.security).toBeUndefined();
  });

  it("reports what the checks came to in the summary", async () => {
    const { summary } = await run(new SecDriver(site));
    expect(summary.security?.checks).toBeGreaterThan(0);
    expect(summary.security?.failed).toBeGreaterThan(0);
    expect(summary.security?.probes).toBe(1);
  });

  it("never lets a failing check cost the exploration a screen", async () => {
    const d = new SecDriver(site);
    const broken = d.newSession.bind(d);
    d.newSession = async (role) => {
      const s = (await broken(role)) as Session;
      return { ...s, probe: async () => Promise.reject(new Error("boom")), rawGet: async () => Promise.reject(new Error("boom")) };
    };
    const { summary, nodes } = await run(d);
    expect(summary.pages).toBe(3);
    expect(nodes.map((n) => n.label).sort()).toEqual(["/", "/orders", "/search"]);
  });
});
