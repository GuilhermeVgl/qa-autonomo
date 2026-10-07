import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../protocol/schemas.js";
import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import { explore, type Driver, type PageView, type ResumeInput, type Session } from "./explorer.js";
import type { ActionResult, ActionSpec, Inventory } from "./interaction.js";
import type { Analyst } from "./interactive.js";
import type { Uploader } from "./regression.js";
import type { Planner } from "./planner.js";
import { EventSink } from "./sink.js";

type Site = Record<string, { sig: string; links?: string[]; status?: number; labels?: Record<string, string>; softError?: string }>;

const BASE = "https://app.test";

class FakeDriver implements Driver {
  visits: { role: string; url: string }[] = [];
  constructor(
    private readonly sites: Record<string, Site>,
    private readonly loginOk = true,
  ) {}

  async newSession(role: string): Promise<Session | null> {
    if (!this.loginOk) return null;
    const site = this.sites[role] ?? this.sites["*"] ?? {};
    return {
      visit: async (url: string): Promise<PageView> => {
        this.visits.push({ role, url });
        const path = new URL(url).pathname;
        const page = site[path] ?? { sig: "404", status: 404 };
        return {
          url,
          status: page.status ?? 200,
          domSignature: page.sig,
          links: (page.links ?? []).map((href) => ({ href: new URL(href, BASE).toString(), label: page.labels?.[href] ?? "link" })),
          ...(page.softError ? { softError: page.softError } : {}),
        };
      },
      close: async () => {},
    };
  }
}

const budget: { max_pages: number; max_depth: number; max_seconds: number; max_llm_calls: number; max_actions?: number } = { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 };
const env = { base_url: BASE + "/", allowed_hosts: ["app.test"], destructive_policy: "block" as const };

async function run(driver: Driver, opts: { creds?: { app_role: string }[]; budget?: Partial<typeof budget>; policy?: "block" | "allow"; stop?: () => boolean; planner?: Planner; resume?: ResumeInput } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await explore({
    driver,
    sink,
    environment: { ...env, destructive_policy: opts.policy ?? "block" },
    credentials: (opts.creds ?? [{ app_role: "admin" }]).map((c) => ({ app_role: c.app_role, kind: "login" as const, payload: { username: "u", password: "p" } })),
    budget: { ...budget, ...opts.budget },
    shouldStop: opts.stop ?? (() => false),
    ...(opts.planner ? { planner: opts.planner } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  await sink.flush();
  const nodes = events.filter((e): e is Extract<RunnerEvent, { type: "node_discovered" }> => e.type === "node_discovered");
  const edges = events.filter((e): e is Extract<RunnerEvent, { type: "edge_discovered" }> => e.type === "edge_discovered");
  return { summary, nodes, edges, events };
}

describe("explore", () => {
  const site: Site = {
    "/": { sig: "home", links: ["/orders", "/customers"] },
    "/orders": { sig: "list", links: ["/", "/orders/1", "/orders/2", "/orders/1/delete"] },
    "/orders/1": { sig: "detail", links: ["/orders"] },
    "/orders/2": { sig: "detail", links: ["/orders"] },
    "/orders/1/delete": { sig: "deleted" },
    "/customers": { sig: "clist", links: ["https://evil.example.org/x", "/reports"] },
  };

  it("maps pages to nodes and links to edges, one node per route pattern", async () => {
    const d = new FakeDriver({ "*": site });
    const { nodes, edges, summary } = await run(d);
    const labels = nodes.map((n) => n.payload.label).sort();
    expect(labels).toEqual(["/", "/customers", "/orders", "/orders/:id", "/reports"]);
    // /orders/1 and /orders/2 render the same state: both visited, one node
    expect(nodes.filter((n) => n.payload.label === "/orders/:id")).toHaveLength(1);
    expect(edges.filter((e) => e.payload.key === "link /orders/:id")).toHaveLength(1);
    expect(summary.pages).toBe(6);
    expect(nodes.every((n) => n.payload.app_role === "admin" && n.payload.kind === "page")).toBe(true);
  });

  it("visits at most 3 samples per route pattern", async () => {
    const many: Site = { "/": { sig: "home", links: [1, 2, 3, 4, 5].map((i) => `/orders/${i}`) } };
    for (let i = 1; i <= 5; i++) many[`/orders/${i}`] = { sig: "detail" };
    const d = new FakeDriver({ "*": many });
    const { edges } = await run(d);
    expect(d.visits.filter((v) => v.url.includes("/orders/"))).toHaveLength(3);
    expect(edges).toHaveLength(1); // all five links lead to the same node: one edge
  });

  it("a sample with a different structure becomes its own node (data-dependent bug surfaces)", async () => {
    const s: Site = {
      "/": { sig: "home", links: ["/customers/1", "/customers/2", "/customers/3"] },
      "/customers/1": { sig: "detail" },
      "/customers/2": { sig: "detail" },
      "/customers/3": { sig: "error", status: 500 },
    };
    const { nodes, summary } = await run(new FakeDriver({ "*": s }));
    expect(nodes.filter((n) => n.payload.label === "/customers/:id")).toHaveLength(2); // detail + error structure
    expect(summary.http_errors).toEqual([{ url: BASE + "/customers/3", status: 500, from: BASE + "/" }]);
  });

  it("every edge connects nodes that were announced before it", async () => {
    const { events } = await run(new FakeDriver({ "*": site }));
    const seen = new Set<string>();
    for (const e of events) {
      if (e.type === "node_discovered") seen.add(e.payload.fingerprint);
      else if (e.type === "edge_discovered") {
        expect(seen.has(e.payload.from_fingerprint)).toBe(true);
        expect(seen.has(e.payload.to_fingerprint)).toBe(true);
      }
    }
  });

  it("never visits out-of-scope hosts and counts them", async () => {
    const d = new FakeDriver({ "*": site });
    const { summary } = await run(d);
    expect(d.visits.some((v) => v.url.includes("evil.example.org"))).toBe(false);
    expect(summary.skipped_out_of_scope).toBe(1);
  });

  it("skips destructive links under block policy, follows them under allow", async () => {
    const blocked = new FakeDriver({ "*": site });
    const r1 = await run(blocked, { policy: "block" });
    expect(blocked.visits.some((v) => v.url.endsWith("/delete"))).toBe(false);
    expect(r1.summary.skipped_destructive).toBe(1);

    const allowed = new FakeDriver({ "*": site });
    await run(allowed, { policy: "allow" });
    expect(allowed.visits.some((v) => v.url.endsWith("/delete"))).toBe(true);
  });

  it("records HTTP error pages with the page that linked to them", async () => {
    const { summary } = await run(new FakeDriver({ "*": site }));
    expect(summary.http_errors).toEqual([{ url: BASE + "/reports", status: 404, from: BASE + "/customers" }]);
  });

  it("respects max_pages and max_depth", async () => {
    const pages = await run(new FakeDriver({ "*": site }), { budget: { max_pages: 2 } });
    expect(pages.nodes).toHaveLength(2);
    expect(pages.summary.stopped_by).toBe("max_pages");

    const depth = await run(new FakeDriver({ "*": site }), { budget: { max_depth: 1 } });
    expect(depth.nodes.map((n) => n.payload.label).sort()).toEqual(["/", "/customers", "/orders"]);
  });

  it("stops when asked (cancellation)", async () => {
    let calls = 0;
    const { nodes, summary } = await run(new FakeDriver({ "*": site }), { stop: () => ++calls > 2 });
    expect(nodes.length).toBeLessThan(5);
    expect(summary.stopped_by).toBe("cancelled");
  });

  it("notes a screen that answers 200 but shows an error, on the node and in the summary", async () => {
    const d = new FakeDriver({ "*": { "/": { sig: "home", links: ["/broken"] }, "/broken": { sig: "err", softError: "Something went wrong" } } });
    const { summary, nodes } = await run(d);
    expect(summary.soft_errors).toEqual([{ url: BASE + "/broken", message: "Something went wrong" }]);
    expect(nodes.find((n) => n.payload.label === "/broken")?.payload.metadata).toMatchObject({ status: 200, soft_error: "Something went wrong" });
    expect(nodes.find((n) => n.payload.label === "/")?.payload.metadata).not.toHaveProperty("soft_error");
  });

  it("explores per role and keeps role-specific nodes apart", async () => {
    const d = new FakeDriver({
      admin: { "/": { sig: "home", links: ["/admin"] }, "/admin": { sig: "admin" } },
      operator: { "/": { sig: "home", links: [] } },
    });
    const { nodes } = await run(d, { creds: [{ app_role: "admin" }, { app_role: "operator" }] });
    const byRole = (r: string) => nodes.filter((n) => n.payload.app_role === r).map((n) => n.payload.label).sort();
    expect(byRole("admin")).toEqual(["/", "/admin"]);
    expect(byRole("operator")).toEqual(["/"]);
    const fps = nodes.map((n) => n.payload.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it("tells how many screens each user reached, and which users could not log in", async () => {
    const driver: Driver = {
      newSession: async (role) =>
        role === "bad"
          ? null
          : new FakeDriver({
              admin: { "/": { sig: "home", links: ["/admin", "/orders"] }, "/admin": { sig: "admin" }, "/orders": { sig: "orders" } },
              operator: { "/": { sig: "home", links: [] } },
            }).newSession(role),
    };
    const { summary } = await run(driver, { creds: [{ app_role: "admin" }, { app_role: "bad" }, { app_role: "operator" }] });
    expect(summary.by_role).toEqual({
      admin: { pages: 3, login_ok: true },
      bad: { pages: 0, login_ok: false },
      operator: { pages: 1, login_ok: true },
    });
  });

  it("reports a failed login and continues with other roles", async () => {
    const driver: Driver = {
      newSession: async (role) => (role === "bad" ? null : new FakeDriver({ "*": { "/": { sig: "home" } } }).newSession(role)),
    };
    const { nodes, summary } = await run(driver, { creds: [{ app_role: "bad" }, { app_role: "good" }] });
    expect(summary.login_failures).toEqual(["bad"]);
    expect(nodes.map((n) => n.payload.app_role)).toEqual(["good"]);
  });

  it("explores anonymously when the environment has no credentials", async () => {
    const { nodes } = await run(new FakeDriver({ "*": site }), { creds: [] });
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]?.payload.app_role).toBe("anonymous");
  });

  it("survives a page that throws on visit", async () => {
    const driver: Driver = {
      newSession: async () => ({
        visit: async (url) => {
          if (url.endsWith("/boom")) throw new Error("net::ERR_FAILED");
          return { url, status: 200, domSignature: "x", links: url.endsWith("/") ? [{ href: BASE + "/boom", label: "b" }] : [] };
        },
        close: async () => {},
      }),
    };
    const { nodes, summary } = await run(driver);
    expect(nodes).toHaveLength(1);
    expect(summary.errors).toEqual([{ url: BASE + "/boom", message: "net::ERR_FAILED" }]);
  });
});

describe("explore with a planner", () => {
  const site: Site = {
    "/": { sig: "home", links: ["/a", "/b", "/c"] },
    "/a": { sig: "a" },
    "/b": { sig: "b" },
    "/c": { sig: "c" },
  };
  const runWith = async (planner: import("./planner.js").Planner) => {
    const d = new FakeDriver({ "*": site });
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await explore({
      driver: d,
      sink,
      environment: env,
      credentials: [],
      budget,
      shouldStop: () => false,
      planner,
    });
    return { d, summary, order: d.visits.map((v) => new URL(v.url).pathname) };
  };

  it("visits candidates in the planner's order", async () => {
    const { order } = await runWith({ rank: async () => [2, 1, 0] });
    expect(order).toEqual(["/", "/c", "/b", "/a"]);
  });

  it("skips what the planner leaves out and counts it", async () => {
    const { order, summary } = await runWith({ rank: async () => [1] });
    expect(order).toEqual(["/", "/b"]);
    expect(summary.planner_skipped).toBe(2);
  });

  it("ignores indices outside the candidate list (the planner cannot add targets)", async () => {
    const { order } = await runWith({ rank: async () => [9, 0, -1, 0, 1.5] });
    expect(order).toEqual(["/", "/a"]);
  });

  it("falls back to the natural order when the planner throws", async () => {
    const { order } = await runWith({
      rank: async () => {
        throw new Error("llm down");
      },
    });
    expect(order).toEqual(["/", "/a", "/b", "/c"]);
  });

  it("only offers links that are in scope and not destructive", async () => {
    const offered: string[][] = [];
    const s: Site = { "/": { sig: "h", links: ["/ok", "https://evil.example.org/x", "/orders/1/delete"] }, "/ok": { sig: "ok" } };
    const d = new FakeDriver({ "*": s });
    const sink = new EventSink(async () => {});
    await explore({
      driver: d,
      sink,
      environment: env,
      credentials: [],
      budget,
      shouldStop: () => false,
      planner: {
        rank: async (_p, cs) => {
          offered.push(cs.map((c) => c.route));
          return cs.map((_, i) => i);
        },
      },
    });
    expect(offered).toEqual([["/ok"]]);
  });
});

// ---- interactive exploration: forms, buttons, requests, modals -------------------------------------------------

interface Screen {
  inventory: Inventory;
  perform?: (a: ActionSpec) => Partial<ActionResult>;
}

const field = (ref: string, name: string, type = "text", required = false) => ({ ref, name, type, label: name, required, placeholder: "", options: [] as string[] });
const newClientForm = {
  ref: "f0", method: "POST", action: "/clients", label: "Novo cliente",
  fields: [field("i0", "client[name]", "text", true), field("i1", "client[email]", "email")],
  submitRef: "b9", submitLabel: "Salvar", hasFile: false, hasPassword: false,
};
const clientsInventory: Inventory = {
  title: "Clientes",
  headings: ["Clientes"],
  buttons: [
    { ref: "b0", label: "Abrir filtros", kind: "button", disabled: false },
    { ref: "b1", label: "Sair", kind: "button", disabled: false },
  ],
  forms: [newClientForm],
};

class InteractiveDriver implements Driver {
  inventories = 0;
  performed: ActionSpec[] = [];
  visits: string[] = [];
  constructor(private readonly screens: Record<string, Screen>, private readonly site: Site) {}
  async newSession(): Promise<Session | null> {
    let current = "/";
    return {
      visit: async (url: string): Promise<PageView> => {
        current = new URL(url).pathname;
        this.visits.push(current);
        const page = this.site[current] ?? { sig: "404", status: 404 };
        return { url, status: page.status ?? 200, domSignature: page.sig, links: (page.links ?? []).map((href) => ({ href: new URL(href, BASE).toString(), label: page.labels?.[href] ?? "link" })) };
      },
      inventory: async () => {
        this.inventories++;
        return structuredClone(this.screens[current]?.inventory ?? { title: "", headings: [], forms: [], buttons: [] });
      },
      perform: async (a: ActionSpec): Promise<ActionResult> => {
        this.performed.push(a);
        return { requests: [], navigatedTo: null, status: 200, modal: null, messages: [], dialog: null, ...(this.screens[current]?.perform?.(a) ?? {}) };
      },
      close: async () => {},
    };
  }
}

const isiteMap: Site = {
  "/": { sig: "home", links: ["/clients"] },
  "/clients": { sig: "clients", links: ["/"] },
  "/clients/7": { sig: "client" },
};
const withActions = { max_actions: 30 };

describe("interactive exploration", () => {
  it("stays on links only when the budget has no actions (what it always did)", async () => {
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory } }, isiteMap);
    const { summary, nodes } = await run(d, { budget: {} });
    expect(d.inventories).toBe(0);
    expect(d.performed).toEqual([]);
    expect(summary.interactive).toBeUndefined();
    expect(nodes.find((n) => n.payload.label === "/clients")?.payload.metadata).toEqual({ status: 200, url: BASE + "/clients" });
  });

  it("learns what a page is and offers: its forms, buttons and a reading of them go into the node", async () => {
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory } }, isiteMap);
    const { nodes } = await run(d, { budget: withActions });
    const meta = nodes.find((n) => n.payload.label === "/clients")?.payload.metadata as Record<string, unknown>;
    expect(meta["summary"]).toContain("/clients");
    expect(meta["forms"]).toEqual([expect.objectContaining({ label: "Novo cliente", method: "POST", action: "/clients" })]);
    expect(meta["controls"]).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Abrir filtros" })]));
    expect(meta["status"]).toBe(200);
  });

  it("maps the endpoint behind a form with its real verb, even when the environment blocks writes", async () => {
    const screens: Record<string, Screen> = {
      "/clients": {
        inventory: clientsInventory,
        perform: (a) =>
          a.type === "submit" && Object.keys(a.values).length > 0
            ? { requests: [{ method: "POST", path: "/clients", resource: "document", status: null, blocked: true, fields: ["client[name]"] }] }
            : {},
      },
    };
    const d = new InteractiveDriver(screens, isiteMap);
    const { nodes, edges, summary } = await run(d, { budget: withActions, policy: "block" });
    const ep = nodes.find((n) => n.payload.kind === "endpoint");
    expect(ep?.payload).toMatchObject({ fingerprint: "POST /clients", label: "POST /clients", metadata: { source: "observed", observed: { blocked: true, fields: ["client[name]"] } } });
    const call = edges.find((e) => e.payload.to_fingerprint === "POST /clients");
    expect(call?.payload).toMatchObject({ key: "call POST /clients", action: { type: "request", method: "POST", trigger: "Salvar", blocked: true } });
    expect(summary.interactive).toMatchObject({ forms_submitted: 1, endpoints_observed: 1, writes_blocked: 1 });
  });

  it("follows where a submission led, as a submit edge", async () => {
    const screens: Record<string, Screen> = {
      "/clients": { inventory: clientsInventory, perform: (a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? { navigatedTo: BASE + "/clients/7" } : {}) },
    };
    const d = new InteractiveDriver(screens, isiteMap);
    const { edges, nodes } = await run(d, { budget: withActions, policy: "allow" });
    expect(d.visits).toContain("/clients/7");
    expect(nodes.some((n) => n.payload.label === "/clients/:id")).toBe(true);
    expect(edges.some((e) => (e.payload.action as { type?: string }).type === "submit" && e.payload.key.startsWith("submit Salvar"))).toBe(true);
  });

  it("always follows where an action led, even when the planner would drop it: the AI orders, it does not decide what exists", async () => {
    const screens: Record<string, Screen> = {
      "/clients": { inventory: clientsInventory, perform: (a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? { navigatedTo: BASE + "/clients/7" } : {}) },
    };
    // drops every candidate that leads to a client page, whatever brought it
    const dropAll: Planner = { rank: async (_page, candidates) => candidates.flatMap((c, i) => (c.route === "/clients/:id" ? [] : [i])) };
    const d = new InteractiveDriver(screens, isiteMap);
    const { nodes, summary } = await run(d, { budget: withActions, policy: "allow", planner: dropAll });
    expect(d.visits).toContain("/clients/7");
    expect(nodes.some((n) => n.payload.label === "/clients/:id")).toBe(true);
    expect(summary.planner_skipped).toBe(0); // it was forced, not skipped
  });

  it("puts a modal on the map with the click that opens it", async () => {
    const screens: Record<string, Screen> = {
      "/clients": {
        inventory: { ...clientsInventory, forms: [] },
        perform: (a) => (a.type === "click" && a.label === "Abrir filtros" ? { modal: { signature: "dialog(form)", inventory: { title: "", headings: [], buttons: [], forms: [] } } } : {}),
      },
    };
    const d = new InteractiveDriver(screens, isiteMap);
    const { nodes, edges } = await run(d, { budget: withActions });
    const modal = nodes.find((n) => n.payload.kind === "modal");
    expect(modal?.payload.label).toBe("/clients › Abrir filtros");
    expect(edges.some((e) => e.payload.to_fingerprint === modal?.payload.fingerprint && e.payload.key === "open Abrir filtros")).toBe(true);
  });

  it("follows the links a click revealed (a menu, a tab, an accordion), not only the ones on the page", async () => {
    const screens: Record<string, Screen> = {
      "/clients": {
        inventory: { ...clientsInventory, forms: [] },
        perform: (a) => (a.type === "click" && a.label === "Abrir filtros" ? { links: [{ href: BASE + "/clients/archived", label: "Arquivados" }] } : {}),
      },
    };
    const site: Site = { ...isiteMap, "/clients/archived": { sig: "archived" } };
    const d = new InteractiveDriver(screens, site);
    const { nodes, edges } = await run(d, { budget: withActions });
    expect(d.visits).toContain("/clients/archived");
    expect(nodes.some((n) => n.payload.label === "/clients/archived")).toBe(true);
    const edge = edges.find((e) => e.payload.to_fingerprint === nodes.find((n) => n.payload.label === "/clients/archived")?.payload.fingerprint);
    expect(edge?.payload.key).toContain("Abrir filtros › Arquivados");
  });

  it("examines a screen once, not once per sampled URL, and never presses logout", async () => {
    const site: Site = { "/": { sig: "home", links: ["/clients/1", "/clients/2"] }, "/clients/1": { sig: "client" }, "/clients/2": { sig: "client" } };
    const d = new InteractiveDriver({ "/clients/1": { inventory: clientsInventory }, "/clients/2": { inventory: clientsInventory } }, site);
    const { summary } = await run(d, { budget: withActions });
    expect(summary.interactive?.pages_examined).toBe(2); // home + the one client screen, not both client URLs
    expect(d.performed.some((a) => a.type === "click" && a.label === "Sair")).toBe(false);
  });

  it("gives every user the whole action budget, and each user's endpoints and windows are recorded for them", async () => {
    const screens: Record<string, Screen> = {
      "/clients": {
        inventory: clientsInventory,
        perform: (a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? { requests: [{ method: "POST", path: "/clients", resource: "document", status: null, blocked: true, fields: ["client[name]"] }] } : {}),
      },
    };
    const d = new InteractiveDriver(screens, isiteMap);
    const { nodes, summary } = await run(d, { budget: { max_actions: 4 }, creds: [{ app_role: "admin" }, { app_role: "operator" }] });
    // 4 actions would be all there is if the budget were shared; each user gets their own 4
    expect(d.performed.length).toBeGreaterThan(4);
    const endpointRoles = nodes.filter((n) => n.payload.kind === "endpoint" && n.payload.fingerprint === "POST /clients").map((n) => n.payload.app_role).sort();
    expect(endpointRoles).toEqual(["admin", "operator"]); // the server merges them into one node with both users
    expect(summary.interactive?.endpoints_observed).toBe(2);
    expect(summary.interactive?.pages_examined).toBeGreaterThanOrEqual(4);
  });

  it("test data stays unique across users within a run", async () => {
    const screens: Record<string, Screen> = { "/clients": { inventory: clientsInventory } };
    const d = new InteractiveDriver(screens, isiteMap);
    await run(d, { budget: { max_actions: 6 }, policy: "allow", creds: [{ app_role: "admin" }, { app_role: "operator" }] });
    const names = d.performed.flatMap((a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? [String(Object.values(a.values)[0])] : []));
    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("spends the action budget of a user across their whole exploration", async () => {
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory }, "/": { inventory: clientsInventory } }, isiteMap);
    const { summary } = await run(d, { budget: { max_actions: 3 } });
    expect(d.performed.length).toBeLessThanOrEqual(3);
    expect(summary.interactive?.actions).toBe(d.performed.length);
  });

  it("hands the page to the analyst and keeps its reading", async () => {
    const analyst: Analyst = {
      understand: async (route) => ({ summary: `IA leu ${route}`, buttons: {}, forms: { f0: { purpose: "Cadastrar cliente", values: { i0: "Maria IA" } } } }),
    };
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory } }, isiteMap);
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    await explore({
      driver: d, sink, environment: env, analyst,
      credentials: [{ app_role: "admin", kind: "login", payload: { username: "u", password: "p" } }],
      budget: { ...budget, ...withActions }, shouldStop: () => false,
    });
    await sink.flush();
    const clients = events.find((e) => e.type === "node_discovered" && e.payload.label === "/clients");
    expect((clients?.payload as unknown as { metadata: { summary: string } }).metadata.summary).toBe("IA leu /clients");
    expect(d.performed.some((a) => a.type === "submit" && a.values["i0"] === "Maria IA")).toBe(true);
  });

  it("a failing interaction never breaks the exploration", async () => {
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory } }, isiteMap);
    const original = d.newSession.bind(d);
    d.newSession = async () => {
      const s = (await original()) as Session;
      s.inventory = async () => Promise.reject(new Error("page crashed"));
      return s;
    };
    const { summary, nodes } = await run(d, { budget: withActions });
    expect(nodes.map((n) => n.payload.label)).toContain("/clients");
    expect(summary.errors.some((e) => e.message.includes("page crashed"))).toBe(true);
  });

  it("every edge still connects nodes announced before it", async () => {
    const screens: Record<string, Screen> = {
      "/clients": {
        inventory: clientsInventory,
        perform: (a) => (a.type === "submit" ? { requests: [{ method: "POST", path: "/clients", resource: "document", status: 302, blocked: false, fields: [] }], navigatedTo: BASE + "/clients/7" } : {}),
      },
    };
    const { events } = await run(new InteractiveDriver(screens, isiteMap), { budget: withActions, policy: "allow" });
    const seen = new Set<string>();
    for (const e of events) {
      if (e.type === "node_discovered") seen.add(e.payload.fingerprint);
      else if (e.type === "edge_discovered") {
        expect(seen.has(e.payload.from_fingerprint)).toBe(true);
        expect(seen.has(e.payload.to_fingerprint)).toBe(true);
      }
    }
  });

  it("does not follow logout links, not even where destructive links are allowed", async () => {
    const site: Site = { "/": { sig: "home", links: ["/clients", "/users/sign_out"], labels: { "/users/sign_out": "Sair" } }, "/clients": { sig: "c" }, "/users/sign_out": { sig: "bye" } };
    const d = new FakeDriver({ "*": site });
    await run(d, { policy: "allow" });
    expect(d.visits.some((v) => v.url.endsWith("/sign_out"))).toBe(false);
  });
});

// ---- thumbnails: a picture of every new screen, for the flow view ---------------------------------------------

describe("thumbnails of the screens", () => {
  const pngLike = new Uint8Array([1, 2, 3]);

  /** A driver whose sessions can take a picture; `calls` records what happened in what order. */
  function pictureDriver(site: Site, calls: string[], opts: { failShot?: boolean } = {}): Driver {
    return {
      newSession: async (role) => {
        const inner = (await new FakeDriver({ "*": site }).newSession(role)) as Session;
        return {
          ...inner,
          visit: async (url) => (calls.push(`visit ${new URL(url).pathname}`), inner.visit(url)),
          thumbnail: async () => {
            calls.push("thumbnail");
            if (opts.failShot) throw new Error("screenshot failed");
            return pngLike;
          },
        };
      },
    };
  }

  const uploads: { kind: string; type: string; size: number }[] = [];
  const uploader = (fail = false): Uploader => ({
    upload: async (kind, contentType, bytes) => {
      if (fail) throw new Error("storage down");
      uploads.push({ kind, type: contentType, size: bytes.length });
      return { kind: kind as "screenshot", content_type: contentType, storage_key: `org/run/${uploads.length}.jpg` };
    },
  });

  async function runWith(d: Driver, up?: Uploader) {
    uploads.length = 0;
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await explore({
      driver: d,
      sink,
      environment: env,
      credentials: [{ app_role: "admin", kind: "login", payload: { username: "u", password: "p" } }],
      budget,
      shouldStop: () => false,
      ...(up ? { uploader: up } : {}),
    });
    await sink.flush();
    return { summary, events };
  }

  const site: Site = { "/": { sig: "home", links: ["/orders"] }, "/orders": { sig: "list", links: ["/"] } };

  it("sends one thumbnail per new screen, after the node it belongs to", async () => {
    const calls: string[] = [];
    const { summary, events } = await runWith(pictureDriver(site, calls), uploader());
    const nodes = events.filter((e) => e.type === "node_discovered").map((e) => (e as Extract<RunnerEvent, { type: "node_discovered" }>).payload);
    const thumbs = events.filter((e): e is Extract<RunnerEvent, { type: "node_thumbnail" }> => e.type === "node_thumbnail");
    expect(thumbs.map((t) => t.payload.fingerprint)).toEqual(nodes.map((n) => n.fingerprint));
    expect(thumbs[0]?.payload.artifact).toMatchObject({ kind: "screenshot", content_type: "image/jpeg" });
    for (const t of thumbs) {
      const nodeSeq = events.find((e) => e.type === "node_discovered" && e.payload.fingerprint === t.payload.fingerprint)?.seq ?? 0;
      expect(t.seq).toBeGreaterThan(nodeSeq); // the server needs the node to exist first
    }
    expect(uploads).toEqual([
      { kind: "screenshot", type: "image/jpeg", size: 3 },
      { kind: "screenshot", type: "image/jpeg", size: 3 },
    ]);
    expect(summary.thumbnails).toBe(2);
  });

  it("takes the picture of a screen once, even when several URLs share it, and before anything acts on the page", async () => {
    const calls: string[] = [];
    const many: Site = { "/": { sig: "home", links: ["/c/1", "/c/2", "/c/3"] }, "/c/1": { sig: "client" }, "/c/2": { sig: "client" }, "/c/3": { sig: "client" } };
    await runWith(pictureDriver(many, calls), uploader());
    expect(calls.filter((c) => c === "thumbnail")).toHaveLength(2); // home + one client screen
    expect(calls.indexOf("thumbnail")).toBe(1); // right after the first visit
  });

  it("sends nothing when there is nowhere to put the pictures", async () => {
    const calls: string[] = [];
    const { events, summary } = await runWith(pictureDriver(site, calls));
    expect(events.some((e) => e.type === "node_thumbnail")).toBe(false);
    expect(calls).not.toContain("thumbnail");
    expect(summary.thumbnails).toBe(0);
  });

  it("a picture that cannot be taken or stored never stops the exploration", async () => {
    const a = await runWith(pictureDriver(site, [], { failShot: true }), uploader());
    expect(a.summary.pages).toBe(2);
    expect(a.events.some((e) => e.type === "node_thumbnail")).toBe(false);
    const b = await runWith(pictureDriver(site, []), uploader(true));
    expect(b.summary.pages).toBe(2);
    expect(b.events.some((e) => e.type === "node_thumbnail")).toBe(false);
    expect(b.summary.thumbnails).toBe(0);
  });

  it("also takes the picture of a page that answered with an error: it is what the person wants to see", async () => {
    const broken: Site = { "/": { sig: "home", links: ["/gone"] }, "/gone": { sig: "x", status: 500 } };
    const { events } = await runWith(pictureDriver(broken, []), uploader());
    expect(events.filter((e) => e.type === "node_thumbnail")).toHaveLength(2);
  });
});

describe("continuing an interrupted exploration", () => {
  const known = (path: string, sig: string, role = "admin", followed?: ResumeInput["known"][number]["followed"]) => ({
    fingerprint: nodeFingerprint({ url: BASE + path, domSignature: sig, appRole: role }),
    app_role: role,
    ...(followed ? { followed } : {}),
  });
  const chain: Site = {
    "/": { sig: "home", links: ["/clients"] },
    "/clients": { sig: "clients", links: ["/", "/clients/archived"] },
    "/clients/archived": { sig: "archived" },
  };

  it("does not examine, announce or photograph a screen it already knows, but still follows its links to what is new", async () => {
    const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory }, "/": { inventory: clientsInventory }, "/clients/archived": { inventory: clientsInventory } }, chain);
    const { nodes, summary } = await run(d, { budget: withActions, resume: { generation: 1, known: [known("/", "home"), known("/clients", "clients")] } });
    expect(d.visits).toEqual(expect.arrayContaining(["/", "/clients", "/clients/archived"]));
    expect(nodes.map((n) => n.payload.label)).toEqual(["/clients/archived"]); // only the new screen is announced
    expect(summary.interactive?.pages_examined).toBe(1);
    expect(d.performed.every((a) => a.type !== "click" || a.label !== "Sair")).toBe(true);
    expect(summary.resumed).toEqual({ known_pages: 2 });
  });

  it("follows again where the actions on a known screen had led", async () => {
    const site: Site = { "/": { sig: "home", links: ["/clients"] }, "/clients": { sig: "clients", links: [] }, "/clients/7": { sig: "client" } };
    const followed = [{ url: BASE + "/clients/7", label: "Salvar", type: "submit" as const, intent: "create" as const }];
    const d = new InteractiveDriver({}, site);
    const { nodes, edges } = await run(d, { budget: withActions, resume: { generation: 1, known: [known("/", "home"), known("/clients", "clients", "admin", followed)] } });
    expect(d.visits).toContain("/clients/7");
    expect(nodes.some((n) => n.payload.label === "/clients/:id")).toBe(true);
    expect(edges.some((e) => e.payload.key.startsWith("submit Salvar") && (e.payload.action as { type?: string }).type === "submit")).toBe(true);
  });

  it("only counts new screens against the page budget, so a continuation can get past where the first one stopped", async () => {
    const d = new InteractiveDriver({}, chain);
    const { nodes } = await run(d, { budget: { max_pages: 1 }, resume: { generation: 1, known: [known("/", "home"), known("/clients", "clients")] } });
    expect(nodes.map((n) => n.payload.label)).toEqual(["/clients/archived"]);
  });

  it("knows the screens of each user apart", async () => {
    const d = new InteractiveDriver({ "/": { inventory: clientsInventory } }, { "/": { sig: "home" } });
    const { nodes } = await run(d, { budget: withActions, creds: [{ app_role: "admin" }, { app_role: "operator" }], resume: { generation: 1, known: [known("/", "home", "admin")] } });
    expect(nodes.map((n) => n.payload.app_role)).toEqual(["operator"]); // the operator's home was not known
  });

  it("uses test data that differs from the earlier run's", async () => {
    const mk = async (generation: number) => {
      const d = new InteractiveDriver({ "/clients": { inventory: clientsInventory } }, isiteMap);
      await run(d, { budget: { max_actions: 6 }, policy: "allow", resume: { generation, known: [] } });
      return d.performed.flatMap((a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? [String(Object.values(a.values)[0])] : []));
    };
    const [first, second] = [await mk(0), await mk(1)];
    expect(first.length).toBeGreaterThan(0);
    expect(second.filter((v) => first.includes(v))).toEqual([]);
  });

  it("remembers where actions led in the node, for the next continuation", async () => {
    const screens: Record<string, Screen> = {
      "/clients": { inventory: clientsInventory, perform: (a) => (a.type === "submit" && Object.keys(a.values).length > 0 ? { navigatedTo: BASE + "/clients/7" } : {}) },
    };
    const d = new InteractiveDriver(screens, isiteMap);
    const { nodes } = await run(d, { budget: withActions, policy: "allow" });
    const meta = nodes.find((n) => n.payload.label === "/clients")?.payload.metadata as { followed?: unknown };
    expect(meta.followed).toEqual([expect.objectContaining({ url: BASE + "/clients/7", label: "Salvar", type: "submit" })]);
  });
});
