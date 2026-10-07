import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explore, type ExploreSummary } from "../src/agent/explorer.js";
import { LlmPlanner } from "../src/agent/planner.js";
import { runRegression } from "../src/agent/regression.js";
import { EventSink } from "../src/agent/sink.js";
import { BrowserDriver } from "../src/executors/browser/driver.js";
import type { ArtifactRef, RunnerEvent } from "../src/protocol/schemas.js";

interface SampleApp {
  createApp(): Server;
  state: { deletedOrders: number[] };
}

let server: Server;
let app: SampleApp;
let base: string;

beforeAll(async () => {
  const file = fileURLToPath(new URL("../../fixtures/sample-app/server.mjs", import.meta.url));
  app = (await import(pathToFileURL(file).href)) as SampleApp;
  server = app.createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function runExploration(allowedHosts: string[], policy: "block" | "allow" = "block", planner?: LlmPlanner) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const driver = await BrowserDriver.launch({ base_url: base + "/", allowed_hosts: allowedHosts });
  let summary: ExploreSummary;
  try {
    summary = await explore({
      driver,
      sink,
      environment: { base_url: base + "/", allowed_hosts: allowedHosts, destructive_policy: policy },
      credentials: [
        { app_role: "admin", kind: "login", payload: { username: "admin", password: "admin123" } },
        { app_role: "operator", kind: "login", payload: { username: "operator", password: "op123" } },
      ],
      budget: { max_pages: 60, max_depth: 5, max_seconds: 120, max_llm_calls: 0 },
      shouldStop: () => false,
      planner,
    });
  } finally {
    await driver.close();
  }
  await sink.flush();
  const nodes = events.flatMap((e) => (e.type === "node_discovered" ? [e.payload] : []));
  return { summary, nodes, blocked: [...driver.blockedRequests] };
}

describe("exploration against fixtures/sample-app", () => {
  it("maps the app per role, finds the planted failures and respects scope and destructive policy", async () => {
    const { summary, nodes, blocked } = await runExploration(["127.0.0.1"]);

    const labels = (role: string) => nodes.filter((n) => n.app_role === role).map((n) => n.label);
    expect(labels("admin")).toEqual(expect.arrayContaining(["/dashboard", "/orders", "/orders/:id", "/customers", "/customers/:id", "/admin", "/admin/users"]));
    // T4: the operator never sees the admin area; exploration is per role
    expect(labels("operator")).toEqual(expect.arrayContaining(["/dashboard", "/orders", "/customers"]));
    expect(labels("operator").some((l) => l.startsWith("/admin"))).toBe(false);

    // B1 (500) and B2 (404) found, each with the page that linked to them
    const statuses = summary.http_errors.map((e) => `${e.status} ${new URL(e.url).pathname}`);
    expect(statuses).toEqual(expect.arrayContaining(["500 /customers/3", "404 /reports"]));

    // T1: destructive GET never visited, nothing deleted
    expect(app.state.deletedOrders).toEqual([]);
    expect(summary.skipped_destructive).toBeGreaterThan(0);

    // T2: external link neither visited nor requested
    expect(summary.skipped_out_of_scope).toBeGreaterThan(0);
    expect(blocked.filter((u) => u.includes("evil.example.org"))).toEqual([]);

    expect(summary.login_failures).toEqual([]);
    expect(summary.stopped_by).toBe("exhausted");
  }, 120_000);

  it("blocks out-of-scope requests at the network layer even if the page asks for them", async () => {
    // allowed host list WITHOUT the app host: every navigation must be aborted by the executor
    const { summary, nodes, blocked } = await runExploration(["only-this-host.test"]);
    expect(nodes).toHaveLength(0);
    expect(blocked.length).toBeGreaterThan(0);
    expect(summary.login_failures.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("LLM-guided exploration with recorded replies", () => {
  const replies = JSON.parse(readFileSync(new URL("./fixtures/llm-replies.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const replay = async (messages: { content: string }[]): Promise<string> => {
    const route = /Página atual: (\S+)/.exec(messages[1]?.content ?? "")?.[1] ?? "";
    const reply = replies[route];
    if (!reply) throw new Error(`no recorded reply for ${route}`); // the planner must then fall back to the natural order
    return JSON.stringify(reply);
  };

  it("follows the recorded order, skips what the model drops and ignores forged indices", async () => {
    const planner = new LlmPlanner({ chat: replay, maxCalls: 20 });
    const { summary, nodes } = await runExploration(["127.0.0.1"], "block", planner);
    const admin = nodes.filter((n) => n.app_role === "admin").map((n) => n.label);

    // the recording leaves out candidate 0 (/dashboard, a duplicate of the home page) at the root...
    expect(summary.planner_skipped).toBeGreaterThan(0);
    // ...and still maps the business screens
    expect(admin).toEqual(expect.arrayContaining(["/orders", "/orders/:id", "/customers", "/reports", "/admin"]));
    expect(planner.calls).toBeGreaterThan(0);
    // the planner never got the destructive or external links to choose from, so they stay untouched
    expect(app.state.deletedOrders).toEqual([]);
    expect(summary.stopped_by).toBe("exhausted");
  }, 120_000);
});

describe("regression against fixtures/sample-app", () => {
  it("revisits explored nodes: healthy screens pass, the planted 500 and 404 fail, each with a screenshot", async () => {
    // 1) explore as admin and turn every discovered node into a target
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const driver = await BrowserDriver.launch({ base_url: base + "/", allowed_hosts: ["127.0.0.1"] });
    const admin = { app_role: "admin", kind: "login" as const, payload: { username: "admin", password: "admin123" } };
    const budget = { max_pages: 60, max_depth: 5, max_seconds: 120, max_llm_calls: 0 };
    const environment = { base_url: base + "/", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" as const };
    try {
      await explore({ driver, sink, environment, credentials: [admin], budget, shouldStop: () => false });
      await sink.flush();
      const targets = events.flatMap((e, i) =>
        e.type === "node_discovered"
          ? [{
              node_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
              fingerprint: e.payload.fingerprint,
              url: String(e.payload.metadata?.["url"]),
              label: e.payload.label,
              app_role: "admin",
              requirement_keys: ["REQ-001"],
            }]
          : [],
      );
      expect(targets.length).toBeGreaterThan(5);

      // 2) regression over those targets
      const out: RunnerEvent[] = [];
      const regSink = new EventSink(async (e) => void out.push(...e));
      const uploads: string[] = [];
      const summary = await runRegression({
        driver, sink: regSink, environment, credentials: [admin], targets, budget: { ...budget, no_security: true }, shouldStop: () => false, // este teste conta a evidência dos testes, não a das verificações de segurança
        uploader: { upload: async (kind, contentType) => { uploads.push(kind); return { kind: kind as ArtifactRef["kind"], content_type: contentType, storage_key: `o/r/${uploads.length}` }; } },
      });
      await regSink.flush();

      const verdict = new Map<string, string>();
      for (const e of out) {
        if (e.type !== "step_finished") continue;
        const t = targets.find((x) => x.node_id === e.payload.key);
        verdict.set(`${t?.label} ${new URL(t?.url ?? "http://x").pathname}`, e.payload.result);
      }
      expect(verdict.get("/orders /orders")).toBe("pass");
      expect(verdict.get("/reports /reports")).toBe("fail"); // B2
      expect([...verdict.entries()].some(([k, v]) => k.startsWith("/customers/:id /customers/3") && v === "fail")).toBe(true); // B1
      expect(summary.failed).toBeGreaterThanOrEqual(2);
      expect(summary.passed).toBeGreaterThan(3);
      expect(uploads.filter((k) => k === "screenshot").length).toBe(summary.steps); // evidence for every step that loaded a page
      expect(uploads.filter((k) => k === "http").length).toBe(summary.steps); // and what was checked, as data
    } finally {
      await driver.close();
    }
  }, 120_000);
});

describe("API regression against fixtures/sample-app", () => {
  it("checks the contract over real HTTP: healthy endpoints pass, the planted violations fail, DELETE is never sent", async () => {
    const orderSchema = { type: "object", required: ["id", "customer", "total"], properties: { id: { type: "integer" }, customer: { type: "string" }, total: { type: "number" } } };
    const mk = (n: number, method: string, path: string, status: number, schema?: Record<string, unknown>) => ({
      kind: "endpoint" as const,
      node_id: `00000000-0000-0000-0000-0000000000${n}0`,
      fingerprint: `${method} ${path}`,
      label: `${method} ${path}`,
      app_role: "api",
      requirement_keys: [`${method} ${path}`],
      method,
      path,
      query: {},
      status,
      ...(schema ? { schema } : {}),
    });
    const targets = [
      mk(1, "GET", "/api/orders", 200, { type: "array", items: orderSchema }),
      mk(2, "GET", "/api/orders/1", 200, orderSchema),
      mk(3, "GET", "/api/orders/3", 200, orderSchema), // B4: id arrives as a string
      mk(4, "GET", "/api/customers", 200, { type: "array" }), // B5: 500
      mk(5, "DELETE", "/api/orders/2", 204), // T5: must be skipped under policy block
    ];
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const driver = await BrowserDriver.launch({ base_url: base + "/", allowed_hosts: ["127.0.0.1"] }); // not used by API targets
    try {
      const summary = await runRegression({
        driver,
        sink,
        environment: { base_url: base, allowed_hosts: ["127.0.0.1"], destructive_policy: "block" },
        credentials: [{ app_role: "ci", kind: "api_token", payload: { token: "sample-api-token" } }],
        targets,
        uploader: { upload: async (kind, contentType) => ({ kind: "http", content_type: contentType, storage_key: `o/r/${kind}.json` }) },
        budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 },
        shouldStop: () => false,
      });
      await sink.flush();
      const verdict = new Map<string, string>();
      for (const e of events) {
        if (e.type === "step_finished") verdict.set(targets.find((t) => t.node_id === e.payload.key)?.label ?? "?", e.payload.result);
      }
      expect(verdict.get("GET /api/orders")).toBe("pass");
      expect(verdict.get("GET /api/orders/1")).toBe("pass");
      expect(verdict.get("GET /api/orders/3")).toBe("fail");
      expect(verdict.get("GET /api/customers")).toBe("fail");
      expect(verdict.get("DELETE /api/orders/2")).toBe("skipped");
      expect(summary).toMatchObject({ passed: 2, failed: 2, skipped: 1 });
      expect(app.state.deletedOrders).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 120_000);
});

describe("mobile web emulation against fixtures/sample-app", () => {
  const admin = { app_role: "admin", kind: "login" as const, payload: { username: "admin", password: "admin123" } };
  const budget = { max_pages: 40, max_depth: 3, max_seconds: 120, max_llm_calls: 0 };

  async function labels(device: string | undefined) {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const scope = { base_url: base + "/", allowed_hosts: ["127.0.0.1"], device };
    const driver = await BrowserDriver.launch(scope);
    try {
      await explore({ driver, sink, environment: { ...scope, destructive_policy: "block" }, credentials: [admin], budget, shouldStop: () => false });
    } finally {
      await driver.close();
    }
    await sink.flush();
    return events.flatMap((e) => (e.type === "node_discovered" ? [e.payload.label] : []));
  }

  it("a phone sees what a desktop browser does not (the app serves a mobile-only menu)", async () => {
    const desktop = await labels(undefined);
    const phone = await labels("iPhone 13");
    expect(desktop).not.toContain("/mobile-menu");
    expect(phone).toContain("/mobile-menu");
  }, 120_000);

  it("refuses an unknown device instead of silently running on desktop", async () => {
    await expect(BrowserDriver.launch({ base_url: base, allowed_hosts: ["127.0.0.1"], device: "Nokia 3310" })).rejects.toThrow(/unknown device/);
  });
});
