import { describe, expect, it } from "vitest";
import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import type { Job, RunnerEvent } from "../protocol/schemas.js";
import { explore, type Driver, type LoginFailure, type PageView, type Session } from "./explorer.js";
import { runJob, type JobClient } from "./job.js";
import { runRegression } from "./regression.js";
import { EventSink } from "./sink.js";

const BASE = "https://app.test";
type Down = (url: string) => Promise<{ down: boolean; detail: string }>;
const up: Down = async () => ({ down: false, detail: "HTTP 200" });
const down: Down = async () => ({ down: true, detail: "conexão recusada (ECONNREFUSED)" });

interface Script {
  /** role -> why its login fails; absent means it logs in */
  logins?: Record<string, LoginFailure>;
  /** what visiting a path does: a status, or a thrown message */
  pages?: Record<string, { status?: number; throws?: string; links?: string[]; sig?: string }>;
}

function scripted(s: Script) {
  const state = { sessions: [] as string[], visits: [] as string[] };
  const d: Driver = {
    loginFailure: (role) => s.logins?.[role],
    newSession: async (role): Promise<Session | null> => {
      state.sessions.push(role);
      if (s.logins?.[role]) return null;
      return {
        visit: async (url): Promise<PageView> => {
          const path = new URL(url).pathname;
          state.visits.push(path);
          const p = s.pages?.[path] ?? { sig: "x" };
          if (p.throws) throw new Error(p.throws);
          return { url, status: p.status ?? 200, domSignature: p.sig ?? "x", links: (p.links ?? []).map((h) => ({ href: new URL(h, BASE).toString(), label: "link" })) };
        },
        screenshot: async () => new Uint8Array([1]),
        close: async () => {},
      };
    },
  };
  return { d, state };
}

const creds = (...roles: string[]) => roles.map((r) => ({ app_role: r, kind: "login" as const, payload: { username: "u", password: "p" } }));
const budget = { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 };
const env = { base_url: BASE + "/", allowed_hosts: ["app.test"], destructive_policy: "block" as const };

async function exploring(d: Driver, roles: string[], isDown: Down = up) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await explore({ driver: d, sink, environment: env, credentials: creds(...roles), budget, shouldStop: () => false, isDown });
  await sink.flush();
  return { summary, events, nodes: events.flatMap((e) => (e.type === "node_discovered" ? [e.payload] : [])) };
}

const refused: LoginFailure = { reason: "rejected", message: "o login não foi aceito: a tela de login continua aberta." };

describe("exploration that cannot log in", () => {
  it("says so once, with the reason for each user, and stops: there is nothing to map", async () => {
    const { d } = scripted({ logins: { admin: refused } });
    const { summary, nodes } = await exploring(d, ["admin"]);
    expect(nodes).toEqual([]);
    expect(summary.stopped_by).toBe("blocked");
    expect(summary.blocked).toMatchObject({ kind: "login_failed", roles: ["admin"], details: [{ role: "admin", reason: "rejected", message: refused.message }] });
    expect(summary.blocked?.message).toContain("admin");
    expect(summary.blocked?.message).toContain("o login não foi aceito");
    expect(summary.login_failures).toEqual(["admin"]);
  });

  it("maps the users that can get in and still says who could not", async () => {
    const { d } = scripted({ logins: { bad: refused } });
    const { summary, nodes } = await exploring(d, ["bad", "good"]);
    expect(nodes.map((n) => n.app_role)).toEqual(["good"]);
    expect(summary.stopped_by).toBe("exhausted");
    expect(summary.blocked).toMatchObject({ kind: "login_failed", roles: ["bad"] });
  });

  it("is no problem at all when every login works", async () => {
    const { d } = scripted({});
    expect((await exploring(d, ["a", "b"])).summary.blocked).toBeUndefined();
  });
});

describe("exploration of an application that is down", () => {
  it("stops at the login that found nothing answering, without trying the other users", async () => {
    const { d, state } = scripted({ logins: { a: { reason: "unreachable", message: "a aplicação não abriu: net::ERR_CONNECTION_REFUSED" }, b: { reason: "unreachable", message: "x" } } });
    const { summary } = await exploring(d, ["a", "b"], down);
    expect(summary.blocked).toMatchObject({ kind: "app_down" });
    expect(summary.blocked?.message).toContain("conexão recusada");
    expect(summary.blocked?.message).toContain("app.test");
    expect(summary.stopped_by).toBe("blocked");
    expect(state.sessions).toEqual(["a"]);
  });

  it("calls an unreachable login a login problem when the application turns out to be up", async () => {
    const { d } = scripted({ logins: { a: { reason: "unreachable", message: "tempo esgotado" } } });
    expect((await exploring(d, ["a"], up)).summary.blocked?.kind).toBe("login_failed");
  });

  it("stops when pages stop loading because the application went away, and keeps what was mapped before", async () => {
    const { d, state } = scripted({ pages: { "/": { links: ["/a", "/b"] }, "/a": { throws: "page.goto: net::ERR_CONNECTION_REFUSED at https://app.test/a" } } });
    const { summary, nodes } = await exploring(d, ["admin"], down);
    expect(summary.blocked).toMatchObject({ kind: "app_down" });
    expect(summary.stopped_by).toBe("blocked");
    expect(nodes.map((n) => n.label)).toEqual(["/"]);
    expect(state.visits).not.toContain("/b"); // it did not go on asking an application that is not there
  });

  it("takes a network error for a page's own problem when the application answers", async () => {
    const { d, state } = scripted({ pages: { "/": { links: ["/a", "/b"] }, "/a": { throws: "net::ERR_CONNECTION_RESET" } } });
    const { summary } = await exploring(d, ["admin"], up);
    expect(summary.blocked).toBeUndefined();
    expect(state.visits).toContain("/b");
    expect(summary.errors).toHaveLength(1);
  });

  it("asks the application only when something looks wrong, never on a healthy run", async () => {
    const { d } = scripted({ pages: { "/": { links: ["/a"] } } });
    let asked = 0;
    await exploring(d, ["admin"], async () => (asked++, { down: false, detail: "" }));
    expect(asked).toBe(0);
  });

  it("stops on a gateway error from the home page when the application is gone, and reports an ordinary 503 when it is not", async () => {
    const gone = scripted({ pages: { "/": { status: 503 } } });
    expect((await exploring(gone.d, ["admin"], down)).summary.blocked?.kind).toBe("app_down");
    const alive = scripted({ pages: { "/": { status: 503 } } });
    const r = await exploring(alive.d, ["admin"], up);
    expect(r.summary.blocked).toBeUndefined();
    expect(r.summary.http_errors).toEqual([{ url: BASE + "/", status: 503, from: null }]);
  });
});

// ---- regression ----

const target = (path: string, role = "admin"): NonNullable<Job["targets"]>[number] => ({
  node_id: `00000000-0000-0000-0000-0000000000${String(path.length).padStart(2, "0")}`,
  fingerprint: nodeFingerprint({ url: BASE + path, domSignature: "x", appRole: role }),
  url: BASE + path,
  label: path,
  app_role: role,
  requirement_keys: ["REQ-001"],
});

async function regressing(d: Driver, targets: ReturnType<typeof target>[], roles: string[], isDown: Down = up) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await runRegression({
    driver: d,
    sink,
    environment: env,
    credentials: creds(...roles),
    targets,
    uploader: { upload: async (k, ct) => ({ kind: k as "screenshot", content_type: ct, storage_key: "k" }) },
    budget,
    shouldStop: () => false,
    retryDelayMs: 0,
    isDown,
  });
  await sink.flush();
  const finished = events.flatMap((e) => (e.type === "step_finished" ? [e.payload] : []));
  return { summary, finished, started: events.filter((e) => e.type === "step_started") };
}

describe("regression that cannot log in", () => {
  it("records nothing as a failure: no step, no bug, one report of what stopped it", async () => {
    const { d } = scripted({ logins: { admin: refused } });
    const { summary, finished, started } = await regressing(d, [target("/a"), target("/bb"), target("/ccc")], ["admin"]);
    expect(started).toEqual([]);
    expect(finished).toEqual([]);
    expect(summary).toMatchObject({ steps: 0, failed: 0, errors: 0, not_tested: 3, stopped_by: "blocked" });
    expect(summary.blocked).toMatchObject({ kind: "login_failed", roles: ["admin"] });
  });

  it("tests the users that can get in, and says which could not and how many screens that left untested", async () => {
    const { d } = scripted({ logins: { op: refused } });
    const { summary, finished } = await regressing(d, [target("/a"), target("/bb", "op"), target("/ccc", "op")], ["admin", "op"]);
    expect(finished).toHaveLength(1);
    expect(summary).toMatchObject({ passed: 1, not_tested: 2, stopped_by: "exhausted" });
    expect(summary.blocked).toMatchObject({ kind: "login_failed", roles: ["op"] });
  });
});

describe("regression of an application that is down", () => {
  it("stops, records nothing for the screen that could not load, and keeps what it had tested", async () => {
    const { d, state } = scripted({ pages: { "/bb": { throws: "page.goto: net::ERR_CONNECTION_REFUSED" } } });
    const { summary, finished } = await regressing(d, [target("/a"), target("/bb"), target("/ccc")], ["admin"], down);
    expect(finished).toHaveLength(1); // /a, tested before it went away
    expect(summary.blocked).toMatchObject({ kind: "app_down" });
    expect(summary.stopped_by).toBe("blocked");
    expect(state.visits).not.toContain("/ccc");
    expect(summary.errors).toBe(0);
  });

  it("a gateway error everywhere is the application being gone, not a bug on every screen", async () => {
    const { d } = scripted({ pages: { "/a": { status: 502 }, "/bb": { status: 502 } } });
    const { summary, finished } = await regressing(d, [target("/a"), target("/bb")], ["admin"], down);
    expect(finished).toEqual([]);
    expect(summary.blocked?.kind).toBe("app_down");
  });

  it("still reports a screen's own 503 or network error when the application as a whole answers", async () => {
    const { d } = scripted({ pages: { "/a": { status: 503 }, "/bb": { throws: "net::ERR_CONNECTION_RESET" } } });
    const { summary, finished } = await regressing(d, [target("/a"), target("/bb")], ["admin"], up);
    expect(finished.map((f) => f.result)).toEqual(["fail", "error"]);
    expect(summary.blocked).toBeUndefined();
  });
});

// ---- the job ----

class Client implements JobClient {
  completed: { status: string; summary: Record<string, unknown> }[] = [];
  async heartbeat() {
    return { cancel: false };
  }
  async sendEvents() {}
  async complete(_id: string, status: "succeeded" | "failed", summary: Record<string, unknown>) {
    this.completed.push({ status, summary });
  }
}

const job = (over: Partial<Job>): Job => ({
  run_id: "0198c1f0-0000-7000-8000-000000000001",
  attempt: 1,
  graph_id: "0198c1f0-0000-7000-8000-000000000002",
  type: "exploration",
  budget,
  environment: env,
  credentials: creds("admin"),
  ...over,
});

describe("how a blocked run ends", () => {
  it("fails with the reason when nothing could be done, so it is not mistaken for a run that found nothing", async () => {
    const { d } = scripted({ logins: { admin: refused } });
    const client = new Client();
    await runJob({ client, job: job({}), driver: d, heartbeatMs: 1000 });
    expect(client.completed[0]?.status).toBe("failed");
    expect(client.completed[0]?.summary["error"]).toContain("admin");
    expect(client.completed[0]?.summary["blocked"]).toMatchObject({ kind: "login_failed" });
  });

  it("succeeds, with the problem noted, when other users could be mapped", async () => {
    const { d } = scripted({ logins: { bad: refused } });
    const client = new Client();
    await runJob({ client, job: job({ credentials: creds("bad", "good") }), driver: d, heartbeatMs: 1000 });
    expect(client.completed[0]?.status).toBe("succeeded");
    expect(client.completed[0]?.summary["blocked"]).toMatchObject({ kind: "login_failed", roles: ["bad"] });
  });

  it("fails a regression that tested nothing for the same reason", async () => {
    const { d } = scripted({ logins: { admin: refused } });
    const client = new Client();
    await runJob({ client, job: job({ type: "regression", targets: [target("/a")] }), driver: d, heartbeatMs: 1000 });
    expect(client.completed[0]?.status).toBe("failed");
  });
});
