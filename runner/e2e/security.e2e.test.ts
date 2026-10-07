import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explore, type ExploreSummary } from "../src/agent/explorer.js";
import { runRegression } from "../src/agent/regression.js";
import { EventSink } from "../src/agent/sink.js";
import { BrowserDriver } from "../src/executors/browser/driver.js";
import type { Job, RunnerEvent } from "../src/protocol/schemas.js";

interface SampleApp {
  createApp(): Server;
  state: { secWrites: number };
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

const creds = [{ app_role: "sec", kind: "login" as const, payload: { username: "sec", password: "sec123" } }];

async function exploreSec(extra: { no_security?: boolean } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const env = { base_url: base + "/sec", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" as const };
  const driver = await BrowserDriver.launch({ ...env, security: !extra.no_security });
  let summary: ExploreSummary;
  try {
    summary = await explore({ driver, sink, environment: env, credentials: creds, budget: { max_pages: 30, max_depth: 3, max_seconds: 120, max_llm_calls: 0, max_actions: 0, ...extra }, shouldStop: () => false });
  } finally {
    await driver.close();
  }
  await sink.flush();
  return { summary, events, ...steps(events) };
}

function steps(events: RunnerEvent[]) {
  const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
  const finished = new Map(events.flatMap((e) => (e.type === "step_finished" ? [[e.payload.key, e.payload] as const] : [])));
  const all = started.map((s) => ({ ...s, ...finished.get(s.key) }));
  const find = (check: string, scope?: string) => all.find((s) => s.security?.check === check && (scope === undefined || s.security?.scope === scope));
  return { all, find };
}

describe("security checks in a real browser, against an application with planted flaws", () => {
  it("finds the classic holes while exploring, and does not change anything in the application", async () => {
    const before = app.state.secWrites;
    const { find, all, summary } = await exploreSec();

    // what every response should carry
    expect(find("header-csp")).toMatchObject({ result: "fail" });
    expect(find("header-frame")).toMatchObject({ result: "fail" });
    expect(find("header-nosniff")).toMatchObject({ result: "fail" });
    expect(find("banner")).toMatchObject({ result: "fail" });
    // the session cookie, read from the raw Set-Cookie
    expect(find("cookie-httponly", "sec_session")).toMatchObject({ result: "fail", security: { severity: "high" } });
    expect(find("cookie-samesite", "sec_session")).toMatchObject({ result: "fail" });
    // CSRF: a form that writes, without a token, and a session cookie that says nothing about SameSite
    expect(find("csrf-token", "POST /sec/notes")).toMatchObject({ result: "fail", security: { severity: "normal" } });
    // injections: the reflected parameter fails, the one that escapes passes
    expect(find("xss-reflected", "/sec/search?q")).toMatchObject({ result: "fail", security: { severity: "high" } });
    expect(find("xss-reflected", "/sec/safe?q")).toMatchObject({ result: "pass" });
    expect(find("sqli-error", "/sec/item?id")).toMatchObject({ result: "fail", security: { severity: "critical" } });
    expect(find("open-redirect", "/sec/go?next")).toMatchObject({ result: "fail" });
    // what the application gives away
    expect(find("info-stacktrace")).toMatchObject({ result: "fail" });
    expect(find("exposed-file", "/.env")).toMatchObject({ result: "fail", security: { severity: "critical" } });
    expect(find("exposed-file", "/.git/HEAD")).toMatchObject({ result: "pass" });
    expect(find("cors-reflect")).toMatchObject({ result: "fail" });

    // every step hangs on a screen announced by the same run
    const fingerprints = new Set(summary ? all.map((s) => s.node_fingerprint) : []);
    expect(fingerprints.size).toBeGreaterThan(0);
    // reads only: the form that writes was never sent
    expect(app.state.secWrites).toBe(before);
    expect(summary.security?.failed).toBeGreaterThan(10);
    expect(summary.security?.by_severity.critical).toBeGreaterThanOrEqual(2);
  });

  it("attaches each step to a screen the run announced", async () => {
    const { events, all } = await exploreSec();
    const announced = new Set(events.flatMap((e) => (e.type === "node_discovered" ? [e.payload.fingerprint] : [])));
    for (const s of all) expect(announced.has(s.node_fingerprint as string), s.key).toBe(true);
  });

  it("does nothing of the sort when the run turns the checks off", async () => {
    const { all, summary } = await exploreSec({ no_security: true });
    expect(all).toEqual([]);
    expect(summary.security).toBeUndefined();
  });

  it("the regression tries the same injections again on the screens it tests, from what the exploration remembered", async () => {
    const explored = await exploreSec();
    const nodes = explored.events.flatMap((e) => (e.type === "node_discovered" && e.payload.kind === "page" ? [e.payload] : []));
    const targets: NonNullable<Job["targets"]> = nodes.map((n, i) => {
      const meta = n.metadata as { url: string; query?: string[] };
      return {
        node_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
        fingerprint: n.fingerprint,
        url: meta.url,
        label: n.label,
        app_role: "sec",
        requirement_keys: [],
        ...(meta.query ? { probes: [{ url: meta.url, params: meta.query }] } : {}),
      };
    });
    expect(targets.some((t) => t.probes)).toBe(true);

    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const env = { base_url: base + "/sec", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" as const };
    const driver = await BrowserDriver.launch({ ...env, security: true });
    let summary;
    try {
      summary = await runRegression({
        driver,
        sink,
        environment: env,
        credentials: creds,
        targets,
        uploader: { upload: async (kind, ct) => ({ kind: kind as "screenshot", content_type: ct, storage_key: "k" }) },
        budget: { max_pages: 30, max_depth: 3, max_seconds: 120, max_llm_calls: 0 },
        shouldStop: () => false,
      });
    } finally {
      await driver.close();
    }
    await sink.flush();
    const { find } = steps(events);
    const xss = find("xss-reflected", "/sec/search?q");
    expect(xss).toMatchObject({ result: "fail" });
    expect(xss?.node_id).toMatch(/^00000000-0000-0000-0000-0000000000\d\d$/);
    expect(find("xss-reflected", "/sec/safe?q")).toMatchObject({ result: "pass" });
    expect(find("cookie-httponly", "sec_session")).toMatchObject({ result: "fail" });
    // the tests of the pages are counted apart from the checks
    expect(summary.steps).toBe(targets.length);
  });
});
