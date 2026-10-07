import { describe, expect, it } from "vitest";
import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import type { Job, RunnerEvent } from "../protocol/schemas.js";
import { injection } from "../security/probes.js";
import type { PageFacts, ProbeOutcome } from "../security/types.js";
import type { Driver, PageView, Session } from "./explorer.js";
import { runRegression } from "./regression.js";
import { EventSink } from "./sink.js";

type Target = NonNullable<Job["targets"]>[number];
const BASE = "https://app.test";
const sig = "main(table)";
const good = { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "strict-transport-security": "x" };
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ headers: good, html: true, forms: [], metaCsrf: false, mixed: [], text: "ok", ...over });
const target = (path: string, n: number, over: Partial<Target> = {}): Target => ({
  node_id: `00000000-0000-0000-0000-00000000000${n}`,
  fingerprint: nodeFingerprint({ url: BASE + path, domSignature: sig, appRole: "admin" }),
  url: BASE + path,
  label: path,
  app_role: "admin",
  requirement_keys: ["REQ-001"],
  ...over,
});

function setup(pages: Record<string, PageFacts>, probe?: (u: URL) => Partial<ProbeOutcome>) {
  const calls: string[] = [];
  const d: Driver = {
    newSession: async (): Promise<Session> => ({
      visit: async (url, o): Promise<PageView> => {
        calls.push("visit " + new URL(url).pathname);
        const f = pages[new URL(url).pathname];
        return { url, status: 200, domSignature: sig, links: [], ...(o?.security && f ? { security: f } : {}) };
      },
      screenshot: async () => {
        calls.push("screenshot");
        return new Uint8Array([1]);
      },
      cookieFlags: () => [],
      probe: async (u): Promise<ProbeOutcome> => {
        calls.push("probe " + new URL(u).pathname);
        return { status: 200, finalUrl: u, injected: [], text: "ok", ...probe?.(new URL(u)) };
      },
      rawGet: async () => ({ status: 404, headers: {}, body: "" }),
      close: async () => {},
    }),
  };
  return { d, calls };
}

async function run(targets: Target[], d: Driver, budget: Record<string, unknown> = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await runRegression({
    driver: d,
    sink,
    environment: { base_url: BASE + "/", allowed_hosts: ["app.test"], destructive_policy: "block" },
    credentials: [{ app_role: "admin", kind: "login", payload: { username: "a", password: "b" } }],
    targets,
    uploader: { upload: async (kind, ct) => ({ kind: kind as "screenshot", content_type: ct, storage_key: "k" }) },
    budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0, ...budget },
    shouldStop: () => false,
    retryDelayMs: 0,
  });
  await sink.flush();
  const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
  const finished = new Map(events.flatMap((e) => (e.type === "step_finished" ? [[e.payload.key, e.payload] as const] : [])));
  return { summary, started: started.map((s) => ({ ...s, ...finished.get(s.key) })) };
}

describe("regression with security checks", () => {
  it("reports what a tested screen lacks as a security step on that screen, apart from the test's own count", async () => {
    const { d } = setup({ "/orders": facts({ headers: {} }) });
    const t = target("/orders", 1);
    const { summary, started } = await run([t], d);
    expect(summary).toMatchObject({ steps: 1, passed: 1, failed: 0 }); // the test of the page; the checks are not part of it
    const sec = started.find((s) => s.security?.check === "header-csp");
    expect(sec).toMatchObject({ result: "fail", node_id: t.node_id, executor: "browser" });
    expect(sec?.key).not.toBe(t.node_id);
    expect(summary.security?.failed).toBeGreaterThan(0);
  });

  it("tries the injections the screen was known to take, after the evidence of the page is kept", async () => {
    const { d, calls } = setup({ "/orders": facts() }, (u) => ({ injected: u.searchParams.get("q") === injection(0) ? [0] : [] }));
    const t = target("/orders", 1, { probes: [{ url: BASE + "/orders", params: ["q"] }] });
    const { started, summary } = await run([t], d);
    expect(calls.indexOf("screenshot")).toBeLessThan(calls.indexOf("probe /orders"));
    expect(started.find((s) => s.security?.check === "xss-reflected")).toMatchObject({ result: "fail", node_id: t.node_id, security: { scope: "/orders?q" } });
    expect(summary.security?.probes).toBe(1);
  });

  it("does none of it when the run turned the checks off", async () => {
    const { d, calls } = setup({ "/orders": facts({ headers: {} }) });
    const { started, summary } = await run([target("/orders", 1, { probes: [{ url: BASE + "/orders", params: ["q"] }] })], d, { no_security: true });
    expect(started.filter((s) => s.security)).toEqual([]);
    expect(calls.some((c) => c.startsWith("probe"))).toBe(false);
    expect(summary.security).toBeUndefined();
  });

  it("a screen that already failed is not probed", async () => {
    const d: Driver = {
      newSession: async (): Promise<Session> => ({
        visit: async (url): Promise<PageView> => ({ url, status: 500, domSignature: sig, links: [] }),
        probe: async () => {
          throw new Error("must not be probed");
        },
        rawGet: async () => ({ status: 404, headers: {}, body: "" }),
        close: async () => {},
      }),
    };
    const { summary } = await run([target("/orders", 1, { probes: [{ url: BASE + "/orders", params: ["q"] }] })], d);
    expect(summary.failed).toBe(1);
  });
});
