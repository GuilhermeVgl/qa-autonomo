import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { explore, type ExploreSummary } from "../src/agent/explorer.js";
import { runRegression } from "../src/agent/regression.js";
import { EventSink } from "../src/agent/sink.js";
import { BrowserDriver } from "../src/executors/browser/driver.js";
import type { ArtifactRef, RunnerEvent } from "../src/protocol/schemas.js";

interface SampleApp {
  createApp(): Server;
  state: { deletedOrders: number[]; labWrites: string[]; labCustomers: unknown[]; logouts: number };
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
beforeEach(() => {
  app.state.labWrites.length = 0;
  app.state.labCustomers.length = 0;
  app.state.deletedOrders.length = 0;
  app.state.logouts = 0;
});

async function exploreLab(policy: "block" | "allow") {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const driver = await BrowserDriver.launch({ base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: policy });
  let summary: ExploreSummary;
  try {
    summary = await explore({
      driver,
      sink,
      environment: { base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: policy },
      credentials: [{ app_role: "admin", kind: "login", payload: { username: "admin", password: "admin123" } }],
      budget: { max_pages: 30, max_depth: 3, max_seconds: 120, max_llm_calls: 0, max_actions: 80 },
      shouldStop: () => false,
    });
  } finally {
    await driver.close();
  }
  await sink.flush();
  const nodes = events.filter((e): e is Extract<RunnerEvent, { type: "node_discovered" }> => e.type === "node_discovered").map((e) => e.payload);
  const edges = events.filter((e): e is Extract<RunnerEvent, { type: "edge_discovered" }> => e.type === "edge_discovered").map((e) => e.payload);
  return { summary, nodes, edges };
}

describe("interactive exploration in a real browser", () => {
  it("in an environment that blocks writes it learns every endpoint and verb without changing anything", async () => {
    const { summary, nodes, edges } = await exploreLab("block");

    // nothing reached the server that changes data, and the session was never ended
    expect(app.state.labWrites).toEqual([]);
    expect(app.state.labCustomers).toEqual([]);
    expect(app.state.deletedOrders).toEqual([]);
    expect(app.state.logouts).toBe(0);
    expect(summary.login_failures).toEqual([]);

    // the same address with different verbs is a different endpoint each
    const endpoints = nodes.filter((n) => n.kind === "endpoint").map((n) => n.fingerprint);
    expect(endpoints).toEqual(
      expect.arrayContaining(["POST /lab/customers", "DELETE /lab/customers/{id}", "POST /lab/api/orders", "PATCH /lab/api/orders/{id}", "GET /lab/api/orders"]),
    );
    const blocked = nodes.find((n) => n.fingerprint === "DELETE /lab/customers/{id}");
    expect(blocked?.metadata).toMatchObject({ source: "observed", observed: { blocked: true } });
    const read = nodes.find((n) => n.fingerprint === "GET /lab/api/orders");
    expect(read?.metadata).toMatchObject({ observed: { blocked: false, statuses: [200] } });

    // the page is described by what is on it
    const lab = nodes.find((n) => n.kind === "page" && n.label === "/lab");
    const meta = lab?.metadata as { forms: { label: string; method: string; action: string }[]; controls: { label: string; intent: string }[]; actions: { label: string; requests: string[]; dialog?: string }[] };
    expect(meta.forms.map((f) => `${f.method} ${f.action}`)).toEqual(expect.arrayContaining(["POST /lab/customers", "DELETE /lab/customers/1", "GET /lab/search"]));
    expect(meta.controls.find((c) => c.label === "Novo pedido")?.intent).toBe("create");
    expect(meta.controls.find((c) => c.label === "Marcar como pago")?.intent).toBe("other");
    expect(meta.actions.find((a) => a.label === "Remover cliente")?.dialog).toContain("Remover o cliente 1?");

    // the modal that "Novo pedido" opens is a node, reached by that click
    const modal = nodes.find((n) => n.kind === "modal");
    expect(modal?.label).toBe("/lab › Novo pedido");
    expect(edges.some((e) => e.to_fingerprint === modal?.fingerprint && e.key === "open Novo pedido")).toBe(true);

    // the search form led somewhere
    expect(nodes.some((n) => n.kind === "page" && n.label === "/lab/search")).toBe(true);
    expect(summary.interactive?.writes_blocked).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("in an environment that allows it, it really inserts data, follows where it led and deletes last", async () => {
    const { summary, nodes } = await exploreLab("allow");

    expect(app.state.labWrites).toContain("POST /lab/customers");
    expect(app.state.labWrites).toContain("PATCH /lab/api/orders/1");
    expect(app.state.labWrites).toContain("POST /lab/api/orders");
    expect(app.state.labCustomers.length).toBeGreaterThanOrEqual(1);
    // deleting is the last thing done on the page, so it cannot get in the way of what came before
    expect(app.state.labWrites.indexOf("DELETE /lab/customers/1")).toBeGreaterThan(app.state.labWrites.indexOf("POST /lab/customers"));

    // the record it created has its own page on the map
    expect(nodes.some((n) => n.kind === "page" && n.label === "/lab/customers/:id")).toBe(true);
    // never logs out, even where everything else is allowed
    expect(app.state.logouts).toBe(0);
    // the customer form and the (confirmed) delete form; the order modal is a script button, counted as an action
    expect(summary.interactive?.forms_submitted).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe("form checks of a spec in a real browser", () => {
  /** Explores /lab, then tests the page with the keys the automatic spec gives it. */
  async function regressLab(policy: "block" | "allow") {
    const { nodes } = await exploreLab(policy);
    const lab = nodes.find((n) => n.kind === "page" && n.label === "/lab");
    expect(lab).toBeDefined();
    app.state.labWrites.length = 0;
    app.state.labCustomers.length = 0;
    app.state.deletedOrders.length = 0;

    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const uploads: { kind: string; body: string }[] = [];
    const driver = await BrowserDriver.launch({ base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: policy });
    try {
      const summary = await runRegression({
        driver,
        sink,
        environment: { base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: policy },
        credentials: [{ app_role: "admin", kind: "login", payload: { username: "admin", password: "admin123" } }],
        targets: [
          {
            node_id: "00000000-0000-0000-0000-000000000001",
            fingerprint: lab?.fingerprint ?? "",
            url: String(lab?.metadata?.["url"]),
            label: "/lab",
            app_role: "admin",
            requirement_keys: ["PAGE /lab", "FORM POST /lab/customers", "VALIDATE POST /lab/customers", "FORM GET /lab/search", "FORM DELETE /lab/customers/1"],
          },
        ],
        budget: { max_pages: 10, max_depth: 2, max_seconds: 120, max_llm_calls: 0 },
        shouldStop: () => false,
        uploader: {
          upload: async (kind, contentType, bytes) => {
            uploads.push({ kind, body: new TextDecoder().decode(bytes) });
            return { kind: kind as ArtifactRef["kind"], content_type: contentType, storage_key: `o/r/${uploads.length}` };
          },
        },
      });
      await sink.flush();
      const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
      const finished = events.flatMap((e) => (e.type === "step_finished" ? [e.payload] : []));
      const form = (key: string) => {
        const st = started.find((x) => x.key.endsWith(`#${key}`));
        return { started: st, finished: finished.find((f) => f.key === st?.key) };
      };
      const evidence = (needle: string) => JSON.parse(uploads.find((u) => u.kind === "http" && u.body.includes(needle))?.body ?? "null") as Record<string, unknown> | null;
      return { summary, form, evidence };
    } finally {
      await driver.close();
    }
  }

  it("where writes are blocked, nothing is changed: the write forms are skipped and the search passes, all with evidence", async () => {
    const { summary, form, evidence } = await regressLab("block");
    expect(app.state.labWrites).toEqual([]);
    expect(app.state.labCustomers).toEqual([]);
    expect(summary.failed).toBe(0);

    expect(form("FORM GET /lab/search").finished?.result).toBe("pass");
    const create = form("FORM POST /lab/customers");
    expect(create.finished?.result).toBe("skipped");
    expect(create.finished?.actual).toMatch(/não permite escrever/);
    // what would have been typed is kept even though nothing was sent
    const doc = evidence('"form":{"method":"POST","action":"/lab/customers"}');
    expect(doc).toMatchObject({ kind: "form", policy: "block", result: "skipped" });
    expect(JSON.stringify(doc?.["inputs"])).toContain("Cliente QA");
    expect(form("FORM DELETE /lab/customers/1").finished?.result).toBe("skipped");

    // the empty submission is stopped by the page itself (a required field), so it is checked even where writing is blocked
    const validate = form("VALIDATE POST /lab/customers");
    expect(validate.finished?.result).toBe("pass");
    expect(validate.finished?.actual).toMatch(/a tela mostrou o que falta/);
    const vdoc = evidence('"mode":"validate"');
    expect(vdoc).toMatchObject({ kind: "form", mode: "validate", result: "pass" });
    expect(JSON.stringify(vdoc?.["messages"])).toMatch(/fill out|preencha/i);
    expect(vdoc?.["inputs"]).toEqual([]);
  }, 120_000);

  it("where writes are allowed, the form is really filled and sent, and the evidence shows the inputs and the HTTP answer", async () => {
    const { form, evidence } = await regressLab("allow");
    expect(app.state.labWrites).toContain("POST /lab/customers");
    expect(app.state.labCustomers.length).toBe(1);

    const create = form("FORM POST /lab/customers");
    expect(create.finished?.result).toBe("pass");
    expect(create.finished?.actual).toMatch(/POST \/lab\/customers → \d+/);
    expect(create.finished?.artifacts?.some((a) => a.kind === "http")).toBe(true);
    const doc = evidence('"form":{"method":"POST","action":"/lab/customers"}');
    expect(doc).toMatchObject({ kind: "form", policy: "allow", result: "pass" });
    expect(JSON.stringify(doc?.["inputs"])).toContain("Cliente QA");
    expect(JSON.stringify(doc?.["requests"])).toContain("/lab/customers");

    // sending it empty creates nothing: the page refuses before anything leaves
    expect(form("VALIDATE POST /lab/customers").finished?.result).toBe("pass");
    expect(app.state.labCustomers.length).toBe(1);

    // the delete form only ever runs under "allow", and last
    expect(form("FORM DELETE /lab/customers/1").finished?.result).toBe("pass");
    expect(app.state.logouts).toBe(0);
  }, 120_000);
});

describe("what only shows up later, in a real browser", () => {
  it("waits for a script-rendered page, scrolls to the end of a long one and opens menus, so the map has no holes", async () => {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const driver = await BrowserDriver.launch({ base_url: base + "/lab/spa", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" });
    let summary: ExploreSummary;
    try {
      summary = await explore({
        driver,
        sink,
        environment: { base_url: base + "/lab/spa", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" },
        credentials: [{ app_role: "admin", kind: "login", payload: { username: "admin", password: "admin123" } }],
        budget: { max_pages: 40, max_depth: 2, max_seconds: 120, max_llm_calls: 0, max_actions: 30 },
        shouldStop: () => false,
      });
    } finally {
      await driver.close();
    }
    await sink.flush();
    const labels = events.flatMap((e) => (e.type === "node_discovered" ? [e.payload.label] : []));
    expect(labels).toContain("/lab/spa/detail"); // drawn by a script 700 ms after load
    expect(labels).toContain("/lab/spa/more"); // only added when the page is scrolled to the end
    expect(labels).toContain("/lab/spa/menu-target"); // only exists after clicking "Menu"
    // and the error screen that answers 200 is noted, not taken for a healthy page
    expect(summary.soft_errors).toEqual([{ url: base + "/lab/broken", message: expect.stringContaining("Something went wrong") }]);
    const broken = events.flatMap((e) => (e.type === "node_discovered" && e.payload.label === "/lab/broken" ? [e.payload] : []))[0];
    expect(broken?.metadata).toMatchObject({ status: 200, soft_error: expect.stringContaining("Something went wrong") });
  }, 120_000);
});

describe("pictures of the screens, in a real browser", () => {
  it("takes a JPEG of each new screen and sends it after the node", async () => {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const shots: Uint8Array[] = [];
    const driver = await BrowserDriver.launch({ base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" });
    let summary: ExploreSummary;
    try {
      summary = await explore({
        driver,
        sink,
        environment: { base_url: base + "/lab", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" },
        credentials: [{ app_role: "admin", kind: "login", payload: { username: "admin", password: "admin123" } }],
        budget: { max_pages: 6, max_depth: 1, max_seconds: 60, max_llm_calls: 0, max_actions: 0, no_security: true }, // o teste é das imagens: só elas são enviadas
        shouldStop: () => false,
        uploader: {
          upload: async (kind, contentType, bytes) => {
            shots.push(bytes);
            return { kind: kind as ArtifactRef["kind"], content_type: contentType, storage_key: `o/r/${shots.length}.jpg` };
          },
        },
      });
    } finally {
      await driver.close();
    }
    await sink.flush();
    const pages = events.filter((e) => e.type === "node_discovered" && e.payload.kind === "page").length;
    expect(pages).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === "node_thumbnail")).toHaveLength(pages);
    expect(summary.thumbnails).toBe(pages);
    for (const s of shots) {
      expect([s[0], s[1]]).toEqual([0xff, 0xd8]); // JPEG
      expect(s.length).toBeGreaterThan(1000);
    }
  }, 120_000);
});
