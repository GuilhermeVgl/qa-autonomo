import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../executors/terminal/exec.js";
import { parseHelp } from "../executors/terminal/help.js";
import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import type { Job, RunnerEvent } from "../protocol/schemas.js";
import type { Driver, PageView, Session } from "./explorer.js";
import type { ActionResult, ActionSpec, Inventory } from "./interaction.js";
import { runRegression, type Uploader } from "./regression.js";
import { EventSink } from "./sink.js";

type Target = NonNullable<Job["targets"]>[number];

const BASE = "https://app.test";
const sig = "main(table)";
const target = (path: string, over: Partial<Target> = {}): Target => ({
  node_id: `00000000-0000-0000-0000-00000000000${path.length}`,
  fingerprint: nodeFingerprint({ url: BASE + path, domSignature: sig, appRole: "admin" }),
  url: BASE + path,
  label: path,
  app_role: "admin",
  requirement_keys: ["REQ-001"],
  ...over,
});

interface Page {
  status?: number;
  sig?: string;
  throws?: string;
  noScreenshot?: boolean;
  /** What the page shows as an error while answering 200. */
  softError?: string;
  /** Answers for the 1st, 2nd... visit of the same page; the last one repeats. */
  seq?: Page[];
}

function driver(pages: Record<string, Page>, opts: { loginOk?: boolean } = {}) {
  const visited: string[] = [];
  const counts: Record<string, number> = {};
  const d: Driver = {
    newSession: async (): Promise<Session | null> => {
      if (opts.loginOk === false) return null;
      return {
        visit: async (url): Promise<PageView> => {
          visited.push(url);
          const path = new URL(url).pathname;
          const base = pages[path] ?? { status: 404, sig: "x" };
          const n = (counts[path] = (counts[path] ?? 0) + 1);
          const p = base.seq ? (base.seq[Math.min(n, base.seq.length) - 1] as Page) : base;
          if (p.throws) throw new Error(p.throws);
          return { url, status: p.status ?? 200, domSignature: p.sig ?? sig, links: [], ...(p.softError ? { softError: p.softError } : {}) };
        },
        screenshot: async () => new Uint8Array([1, 2, 3]),
        close: async () => {},
      };
    },
  };
  return { d, visited };
}

const uploader = (fail = false): Uploader & { uploads: string[]; bodies: Record<string, string> } => {
  const uploads: string[] = [];
  const bodies: Record<string, string> = {};
  return {
    uploads,
    bodies,
    upload: async (kind, contentType, bytes) => {
      if (fail) throw new Error("storage down");
      uploads.push(kind);
      if (contentType === "application/json") bodies[kind + uploads.length] = new TextDecoder().decode(bytes);
      return { kind: kind as "screenshot", content_type: contentType, storage_key: `org/run/${uploads.length}.png` };
    },
  };
};

const creds = [{ app_role: "admin", kind: "login" as const, payload: { username: "a", password: "b" } }];
const env = { base_url: BASE + "/", allowed_hosts: ["app.test"], destructive_policy: "block" as const };

async function run(targets: Target[], d: Driver, up: Uploader, over: { stop?: () => boolean; credentials?: typeof creds; concurrency?: number } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await runRegression({
    driver: d,
    sink,
    environment: env,
    credentials: over.credentials ?? creds,
    targets,
    uploader: up,
    budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0, ...(over.concurrency ? { concurrency: over.concurrency } : {}) },
    shouldStop: over.stop ?? (() => false),
    retryDelayMs: 0,
    isDown: async () => ({ down: false, detail: "" }), // these tests are about the screens, not about the network
  });
  await sink.flush();
  const finished = events.flatMap((e) => (e.type === "step_finished" ? [e.payload] : []));
  const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
  return { summary, events, finished, started };
}

describe("runRegression", () => {
  it("passes a node whose page still answers and keeps its structure, with a screenshot as evidence", async () => {
    const { d } = driver({ "/orders": {} });
    const up = uploader();
    const { summary, started, finished } = await run([target("/orders")], d, up);
    expect(summary).toMatchObject({ steps: 1, passed: 1, failed: 0, errors: 0, skipped: 0 });
    expect(started[0]).toMatchObject({ executor: "browser", input: { url: BASE + "/orders" } });
    expect(started[0]?.expected).toContain("structure");
    expect(finished[0]).toMatchObject({ result: "pass" });
    expect(finished[0]?.key).toBe(started[0]?.key);
    expect(finished[0]?.artifacts).toEqual([
      { kind: "screenshot", content_type: "image/png", storage_key: "org/run/1.png" },
      { kind: "http", content_type: "application/json", storage_key: "org/run/2.png" },
    ]);
    expect(up.uploads).toEqual(["screenshot", "http"]);
  });

  it("a failure that goes away on the second try passes, and says it was flaky", async () => {
    const { d, visited } = driver({ "/orders": { seq: [{ status: 503 }, {}] } });
    const up = uploader();
    const { summary, finished } = await run([target("/orders")], d, up);
    expect(summary).toMatchObject({ steps: 1, passed: 1, failed: 0 });
    expect(visited).toHaveLength(2);
    expect(finished[0]?.result).toBe("pass");
    expect(finished[0]?.actual).toMatch(/2ª tentativa.*HTTP 503/);
    const evidence = JSON.parse(Object.values(up.bodies).find((b) => b.includes('"kind":"page"')) as string) as { flaky: boolean; attempts: { actual: string }[] };
    expect(evidence.flaky).toBe(true);
    expect(evidence.attempts).toHaveLength(2);
  });

  it("a server error that persists fails after two tries, and a client error is not retried", async () => {
    const down = driver({ "/orders": { status: 500 } });
    const a = await run([target("/orders")], down.d, uploader());
    expect(a.summary.failed).toBe(1);
    expect(down.visited).toHaveLength(2);
    expect(a.finished[0]?.actual).toMatch(/HTTP 500.*2 tentativas/);

    const gone = driver({ "/orders": { status: 404 } });
    const b = await run([target("/orders")], gone.d, uploader());
    expect(b.summary.failed).toBe(1);
    expect(gone.visited).toHaveLength(1); // 404 is an answer, not a hiccup
  });

  it("an exception on the first visit is retried too", async () => {
    const { d, visited } = driver({ "/orders": { seq: [{ throws: "net::ERR_CONNECTION_RESET" }, {}] } });
    const { summary } = await run([target("/orders")], d, uploader());
    expect(summary).toMatchObject({ passed: 1, errors: 0 });
    expect(visited).toHaveLength(2);
  });

  it("a page that shows an error while answering 200 fails, with the text it showed", async () => {
    const { d } = driver({ "/orders": { softError: "Something went wrong" } });
    const { summary, finished } = await run([target("/orders")], d, uploader());
    expect(summary.failed).toBe(1);
    expect(finished[0]?.actual).toContain("a tela mostra um erro");
    expect(finished[0]?.actual).toContain("Something went wrong");
  });

  it("fails on an HTTP error and says which", async () => {
    const { d } = driver({ "/customers/3": { status: 500 } });
    const { summary, finished } = await run([target("/customers/3")], d, uploader());
    expect(summary.failed).toBe(1);
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toContain("500");
  });

  it("fails when the page structure changed (fingerprint differs) even with HTTP 200", async () => {
    const { d } = driver({ "/orders": { sig: "main(ul)" } });
    const { finished } = await run([target("/orders")], d, uploader());
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toMatch(/structure/);
  });

  it("reports an error (not a failure) when the page cannot be loaded", async () => {
    const { d } = driver({ "/orders": { throws: "net::ERR_TIMED_OUT" } });
    const { summary, finished } = await run([target("/orders")], d, uploader());
    expect(summary).toMatchObject({ errors: 1, failed: 0 });
    expect(finished[0]).toMatchObject({ result: "error" });
    expect(finished[0]?.actual).toContain("ERR_TIMED_OUT");
  });

  it("skips targets outside the allowed hosts without visiting them", async () => {
    const { d, visited } = driver({});
    const { summary, finished } = await run([target("/x", { url: "https://evil.example.org/x" })], d, uploader());
    expect(visited).toEqual([]);
    expect(summary.skipped).toBe(1);
    expect(finished[0]).toMatchObject({ result: "skipped" });
  });

  it("keeps the step result when the screenshot upload fails", async () => {
    const { d } = driver({ "/orders": {} });
    const { finished } = await run([target("/orders")], d, uploader(true));
    expect(finished[0]).toMatchObject({ result: "pass" });
    expect(finished[0]?.artifacts ?? []).toEqual([]);
  });

  it("logs in once per role and tests each target with its own role", async () => {
    const { d, visited } = driver({ "/orders": {}, "/reports": {} });
    const t1 = target("/orders");
    const t2 = target("/reports", { app_role: "operator", fingerprint: nodeFingerprint({ url: BASE + "/reports", domSignature: sig, appRole: "operator" }) });
    const { summary } = await run([t1, t2], d, uploader(), {
      credentials: [...creds, { app_role: "operator", kind: "login" as const, payload: { username: "o", password: "p" } }],
    });
    expect(summary.passed).toBe(2);
    expect(visited).toHaveLength(2);
  });

  it("does not report the screens of a user who cannot log in as failures: they were never tested", async () => {
    const { d } = driver({}, { loginOk: false });
    const { summary, finished } = await run([target("/orders")], d, uploader());
    expect(finished).toEqual([]);
    expect(summary).toMatchObject({ errors: 0, failed: 0, not_tested: 1, login_failures: ["admin"] });
    expect(summary.blocked?.kind).toBe("login_failed");
  });

  it("stops early when cancelled and records nothing more", async () => {
    let calls = 0;
    const { d } = driver({ "/a": {}, "/bb": {}, "/ccc": {} });
    const { summary } = await run([target("/a"), target("/bb"), target("/ccc")], d, uploader(), { stop: () => ++calls > 1 });
    expect(summary.steps).toBeLessThan(3);
  });
});

describe("runRegression with API targets", () => {
  const api = (over: Partial<Target> = {}): Target => ({
    kind: "endpoint",
    node_id: "00000000-0000-0000-0000-0000000000a1",
    fingerprint: "GET /orders/{id}",
    label: "GET /orders/{id}",
    app_role: "api",
    requirement_keys: ["GET /orders/{id}"],
    method: "GET",
    path: "/orders/42",
    query: {},
    status: 200,
    schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
    ...over,
  });
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  async function runApi(targets: Target[], fetchFn: typeof fetch, policy: "block" | "allow" = "block", up: Uploader = uploader()) {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await runRegression({
      driver: driver({}).d,
      sink,
      environment: { ...env, destructive_policy: policy },
      credentials: [{ app_role: "any", kind: "api_token", payload: { token: "secret-token" } }],
      targets,
      uploader: up,
      budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 },
      shouldStop: () => false,
      fetchFn,
    });
    await sink.flush();
    const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
    const finished = events.flatMap((e) => (e.type === "step_finished" ? [e.payload] : []));
    return { summary, started, finished };
  }

  it("passes a conforming response and records an api step with http evidence", async () => {
    const up = uploader();
    const { summary, started, finished } = await runApi([api()], reply(200, { id: 42 }), "block", up);
    expect(summary).toMatchObject({ steps: 1, passed: 1 });
    expect(started[0]).toMatchObject({ executor: "api", input: { method: "GET", path: "/orders/42" } });
    expect(started[0]?.expected).toContain("matches the contract");
    expect(finished[0]).toMatchObject({ result: "pass" });
    expect(up.uploads).toEqual(["http"]);
  });

  it("fails a contract violation with a clear reason", async () => {
    const { summary, finished } = await runApi([api()], reply(200, { id: "x" }));
    expect(summary.failed).toBe(1);
    expect(finished[0]?.actual).toContain("violates the contract");
  });

  it("sends the api_token as a bearer and keeps it out of the evidence", async () => {
    let auth = "";
    let evidence = "";
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const up: Uploader = {
      upload: async (kind, contentType, bytes) => {
        evidence = new TextDecoder().decode(bytes);
        return { kind: "http", content_type: contentType, storage_key: "o/r/e.json" };
      },
    };
    await runApi([api()], fetchFn, "block", up);
    expect(auth).toBe("Bearer secret-token");
    expect(evidence).not.toContain("secret-token");
    expect(evidence).toContain("/orders/42");
  });

  it("skips mutating endpoints unless destructive actions are allowed, and never calls them", async () => {
    let calls = 0;
    const fetchFn = (async () => (calls++, new Response("{}", { status: 201 }))) as unknown as typeof fetch;
    const post = api({ method: "DELETE", status: 204, schema: undefined });
    const blocked = await runApi([post], fetchFn, "block");
    expect(blocked.summary.skipped).toBe(1);
    expect(calls).toBe(0);
    const allowed = await runApi([post], (async () => (calls++, new Response(null, { status: 204 }))) as unknown as typeof fetch, "allow");
    expect(allowed.summary.passed).toBe(1);
    expect(calls).toBe(1);
  });

  it("runs endpoint and page targets in the same run", async () => {
    const { d } = driver({ "/orders": {} });
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await runRegression({
      driver: d, sink, environment: env, credentials: creds, targets: [target("/orders"), api()], uploader: uploader(),
      budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 }, shouldStop: () => false, fetchFn: reply(200, { id: 1 }),
    });
    expect(summary).toMatchObject({ steps: 2, passed: 2 });
  });

  it("reports an incomplete endpoint target as an error", async () => {
    const { summary } = await runApi([api({ method: undefined })], reply(200, {}));
    expect(summary.errors).toBe(1);
  });
});

describe("runRegression on a mobile web environment", () => {
  it("labels page steps as mobile_web", async () => {
    const { d } = driver({ "/orders": {} });
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    await runRegression({
      driver: d, sink, environment: { ...env, device: "iPhone 13" }, credentials: creds, targets: [target("/orders")], uploader: uploader(),
      budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 }, shouldStop: () => false,
    });
    await sink.flush();
    const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
    expect(started[0]?.executor).toBe("mobile_web");
  });
});

describe("runRegression with command targets", () => {
  const HELP = "Available Commands:\n  list  List\n\nFlags:\n  -h, --help  help\n";
  const cmd = (over: Partial<Target> = {}): Target => ({
    kind: "command",
    node_id: "00000000-0000-0000-0000-0000000000c1",
    fingerprint: "samplecli orders",
    label: "samplecli orders",
    app_role: "cli",
    requirement_keys: ["REQ-CLI-1"],
    args: ["orders"],
    help_signature: parseHelp(HELP).signature,
    ...over,
  });
  const cli = (r: Partial<CommandResult> & { stdout?: string }): CommandRunner => ({
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 5, ...r }),
  });

  async function runCmd(targets: Target[], command: CommandRunner | undefined, up: Uploader = uploader()) {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await runRegression({
      driver: driver({}).d, sink, environment: env, credentials: [], targets, uploader: up,
      budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 }, shouldStop: () => false, ...(command ? { command } : {}),
    });
    await sink.flush();
    return {
      summary,
      started: events.flatMap((e) => (e.type === "step_started" ? [e.payload] : [])),
      finished: events.flatMap((e) => (e.type === "step_finished" ? [e.payload] : [])),
    };
  }

  it("passes when --help works and keeps its structure; records a terminal step with stdout evidence", async () => {
    const up = uploader();
    const { summary, started, finished } = await runCmd([cmd()], cli({ stdout: HELP }), up);
    expect(summary).toMatchObject({ steps: 1, passed: 1 });
    expect(started[0]).toMatchObject({ executor: "terminal", input: { args: ["orders"] } });
    expect(finished[0]).toMatchObject({ result: "pass" });
    expect(up.uploads).toEqual(["stdout"]);
  });

  it("fails on a non-zero exit code and quotes the first line of the error", async () => {
    const { finished } = await runCmd([cmd()], cli({ exitCode: 2, stderr: "panic: boom\nstack..." }));
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toContain("exit code 2: panic: boom");
  });

  it("fails when the help structure changed", async () => {
    const { finished } = await runCmd([cmd()], cli({ stdout: HELP.replace("list  List", "list  List\n  purge  Purge") }));
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toMatch(/structure changed/);
  });

  it("reports a timeout as an error and a missing runner as an error", async () => {
    expect((await runCmd([cmd()], cli({ exitCode: 137, timedOut: true }))).finished[0]).toMatchObject({ result: "error" });
    expect((await runCmd([cmd()], undefined)).finished[0]).toMatchObject({ result: "error" });
  });
});

// ---- evidence and form checks ------------------------------------------------------------------------------------


describe("runRegression: evidence of a page", () => {
  it("saves what was checked and what came back, next to the screenshot", async () => {
    const { d } = driver({ "/orders": {} });
    const up = uploader();
    await run([target("/orders")], d, up);
    const evidence = JSON.parse(Object.values(up.bodies)[0] as string) as Record<string, unknown>;
    expect(evidence).toMatchObject({ kind: "page", url: BASE + "/orders", final_url: BASE + "/orders", status: 200, result: "pass", structure: { match: true } });
    expect(String(evidence["expected"])).toContain("HTTP < 400");
    expect(String(evidence["actual"])).toContain("HTTP 200");
  });

  it("keeps the evidence of a failure too, with the status that failed it", async () => {
    const { d } = driver({ "/customers/3": { status: 500 } });
    const up = uploader();
    await run([target("/customers/3")], d, up);
    expect(JSON.parse(Object.values(up.bodies)[0] as string)).toMatchObject({ status: 500, result: "fail" });
  });
});

const field = (ref: string, name: string, type = "text", required = false, label = name) => ({ ref, name, type, label, required, placeholder: "", options: [] as string[] });
const clientForm = {
  ref: "f0", method: "POST", action: "/clients", label: "Novo cliente",
  fields: [field("i0", "client[name]", "text", true, "Nome"), field("i1", "client[email]", "email"), field("i2", "client[api_token]", "text", false, "Token")],
  submitRef: "b0", submitLabel: "Salvar", hasFile: false, hasPassword: false,
};
const inventoryOf = (...forms: Inventory["forms"]): Inventory => ({ title: "Clientes", headings: [], buttons: [], forms });

function formDriver(inv: Inventory | null, reply: (a: ActionSpec) => Partial<ActionResult> = () => ({})) {
  const performed: ActionSpec[] = [];
  const d: Driver = {
    newSession: async (): Promise<Session | null> => ({
      visit: async (url): Promise<PageView> => ({ url, status: 200, domSignature: sig, links: [] }),
      screenshot: async () => new Uint8Array([1]),
      ...(inv
        ? {
            inventory: async () => structuredClone(inv),
            perform: async (a: ActionSpec): Promise<ActionResult> => {
              performed.push(a);
              return { requests: [], navigatedTo: null, status: 200, modal: null, messages: [], dialog: null, ...reply(a) };
            },
          }
        : {}),
      close: async () => {},
    }),
  };
  return { d, performed };
}

const formTarget = (keys: string[]) => target("/clients", { requirement_keys: keys });
const post = (status: number | null, blocked = false) => ({ method: "POST", path: "/clients", resource: "document" as const, status, blocked, fields: ["client[name]"] });

async function runForms(keys: string[], inv: Inventory | null, reply: (a: ActionSpec) => Partial<ActionResult>, policy: "block" | "allow", up = uploader()) {
  const { d, performed } = formDriver(inv, reply);
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await runRegression({
    driver: d, sink, environment: { ...env, destructive_policy: policy }, credentials: creds, targets: [formTarget(keys)], uploader: up,
    budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 }, shouldStop: () => false,
  });
  await sink.flush();
  const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
  // `finished` holds only the steps of the forms; the check of the page itself comes first and has its own tests
  const formKeys = new Set(started.filter((s) => s.key.includes("#FORM") || s.key.includes("#VALIDATE")).map((s) => s.key));
  const finished = events.flatMap((e) => (e.type === "step_finished" && formKeys.has(e.payload.key) ? [e.payload] : []));
  return { summary, started, finished, performed, up };
}

describe("runRegression: in parallel", () => {
  /** A driver whose pages take a while, so overlapping visits show; it counts sessions and the most visits at once. */
  function slowDriver(opts: { failLoginFrom?: number } = {}) {
    const state = { sessions: 0, closed: 0, active: 0, maxActive: 0, visits: [] as string[], logins: 0 };
    const d: Driver = {
      newSession: async (): Promise<Session | null> => {
        const n = ++state.logins;
        if (opts.failLoginFrom !== undefined && n >= opts.failLoginFrom) return null;
        state.sessions++;
        return {
          visit: async (url): Promise<PageView> => {
            state.active++;
            state.maxActive = Math.max(state.maxActive, state.active);
            state.visits.push(url);
            await new Promise((r) => setTimeout(r, 15));
            state.active--;
            return { url, status: 200, domSignature: sig, links: [] };
          },
          screenshot: async () => new Uint8Array([1]),
          close: async () => void state.closed++,
        };
      },
    };
    return { d, state };
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) => target(`/p${i}`, { node_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }));

  it("checks the screens of a user with several browsers at once, each screen exactly once", async () => {
    const { d, state } = slowDriver();
    const { summary, finished } = await run(many(12), d, uploader(), { concurrency: 4 });
    expect(summary).toMatchObject({ steps: 12, passed: 12 });
    expect(state.sessions).toBe(4); // one login per browser
    expect(state.maxActive).toBeGreaterThan(1);
    expect(state.maxActive).toBeLessThanOrEqual(4);
    expect(new Set(state.visits).size).toBe(12);
    expect(finished).toHaveLength(12);
    expect(state.closed).toBe(4); // every browser is closed
  });

  it("is one browser unless asked, and never more browsers than screens", async () => {
    const a = slowDriver();
    await run(many(5), a.d, uploader());
    expect(a.state.sessions).toBe(1);
    expect(a.state.maxActive).toBe(1);
    const b = slowDriver();
    await run(many(2), b.d, uploader(), { concurrency: 4 });
    expect(b.state.sessions).toBe(2);
  });

  it("goes on with fewer browsers when an extra login fails, and fails the user only when the first does", async () => {
    const some = slowDriver({ failLoginFrom: 3 });
    const { summary } = await run(many(10), some.d, uploader(), { concurrency: 4 });
    expect(summary).toMatchObject({ steps: 10, passed: 10 });
    expect(some.state.sessions).toBe(2);
    const none = slowDriver({ failLoginFrom: 1 });
    const failed = await run(many(3), none.d, uploader(), { concurrency: 3 });
    expect(failed.summary.login_failures).toEqual(["admin"]);
    expect(failed.summary).toMatchObject({ errors: 0, steps: 0, not_tested: 3 });
  });

  it("stops every browser when cancelled", async () => {
    const { d, state } = slowDriver();
    let seen = 0;
    const { summary } = await run(many(40), d, uploader(), { concurrency: 4, stop: () => ++seen > 12 });
    expect(summary.stopped_by).toBe("cancelled");
    expect(summary.steps).toBeLessThan(40);
    expect(state.closed).toBe(state.sessions);
  });

  it("tallies by user correctly when browsers share the work", async () => {
    const { d } = slowDriver();
    const { summary } = await run([...many(6), ...many(4).map((t, i) => ({ ...t, app_role: "operator", node_id: `10000000-0000-0000-0000-${String(i).padStart(12, "0")}`, url: BASE + `/o${i}` }))], d, uploader(), { concurrency: 3, credentials: [...creds, { app_role: "operator", kind: "login" as const, payload: { username: "o", password: "p" } }] });
    expect(summary.by_role["admin"]?.steps).toBe(6);
    expect(summary.by_role["operator"]?.steps).toBe(4);
  });
});

describe("runRegression: form checks of a spec", () => {
  it("fills the form with test data and passes when the server accepts it, saving inputs and what came back", async () => {
    const { summary, started, finished, performed, up } = await runForms(["PAGE /clients", "FORM POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(302)], navigatedTo: BASE + "/clients/7", status: 200 }), "allow");
    expect(summary).toMatchObject({ steps: 2, passed: 2, failed: 0 });
    const step = started.find((s) => s.key.includes("FORM POST /clients"));
    expect(step?.executor).toBe("browser");
    expect(step?.expected).toContain("POST /clients");
    const done = finished.find((f) => f.key === step?.key);
    expect(done).toMatchObject({ result: "pass" });
    expect(done?.actual).toContain("POST /clients → 302");
    expect(performed[0]).toMatchObject({ type: "submit", formRef: "f0" });

    const evidence = JSON.parse(Object.entries(up.bodies).map(([, b]) => b).find((b) => b.includes('"kind":"form"')) as string) as { inputs: { field: string; value: string }[]; requests: unknown[]; final_url: string; result: string };
    expect(evidence.result).toBe("pass");
    expect(evidence.inputs.find((i) => i.field === "client[name]")?.value).toMatch(/^Cliente QA \d+$/);
    expect(evidence.requests).toEqual([expect.objectContaining({ method: "POST", path: "/clients", status: 302 })]);
    expect(evidence.final_url).toBe(BASE + "/clients/7");
  });

  it("never writes the value of a sensitive field into the evidence", async () => {
    const { up } = await runForms(["FORM POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(302)] }), "allow");
    const body = Object.values(up.bodies).find((b) => b.includes('"kind":"form"')) as string;
    expect(body).toContain('"client[api_token]"');
    expect(JSON.parse(body).inputs.find((i: { field: string }) => i.field === "client[api_token]").value).toBe("***");
  });

  it("is skipped, not failed, when the environment keeps the agent from writing, and still shows what would have been sent", async () => {
    const { summary, finished, up } = await runForms(["FORM POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(null, true)] }), "block");
    expect(summary).toMatchObject({ steps: 2, passed: 1, skipped: 1, failed: 0 }); // the page passed; the form was not sent
    expect(finished[0]?.actual).toMatch(/não permite escrever|bloque/i);
    expect(finished[0]?.actual).toContain("POST /clients");
    const body = JSON.parse(Object.values(up.bodies).find((b) => b.includes('"kind":"form"')) as string) as { requests: { blocked: boolean }[]; policy: string };
    expect(body.requests[0]?.blocked).toBe(true);
    expect(body.policy).toBe("block");
  });

  it("fails with the HTTP status when the server rejects a valid submission", async () => {
    const { finished, summary } = await runForms(["FORM POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(500)] }), "allow");
    expect(summary).toMatchObject({ passed: 1, failed: 1 });
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toContain("HTTP 500");
  });

  it("fails when the page showed validation problems and nothing was sent", async () => {
    const { finished } = await runForms(["FORM POST /clients"], inventoryOf(clientForm), () => ({ messages: ["client[name]: Preencha este campo."] }), "allow");
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toContain("Preencha este campo");
  });

  it("fails when the form is no longer on the page", async () => {
    const { finished, performed } = await runForms(["FORM POST /clients"], inventoryOf(), () => ({}), "allow");
    expect(performed).toEqual([]);
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toMatch(/não está mais|not found/i);
  });

  it("a search form passes when it leads to a page that answers", async () => {
    const search = { ...clientForm, ref: "f1", method: "GET", action: "/clients", label: "Busca", fields: [field("i9", "q", "search")], submitLabel: "Buscar" };
    const { finished } = await runForms(["FORM GET /clients"], inventoryOf(search), () => ({ navigatedTo: BASE + "/clients?q=teste", status: 200, requests: [{ method: "GET", path: "/clients", resource: "document", status: 200, blocked: false, fields: [] }] }), "block");
    expect(finished[0]).toMatchObject({ result: "pass" });
  });

  it("leaves risky forms alone unless the environment allows them", async () => {
    const remove = { ...clientForm, ref: "f3", method: "DELETE", action: "/clients/1", label: "Remover", fields: [], submitLabel: "Remover cliente" };
    const blocked = await runForms(["FORM DELETE /clients/1"], inventoryOf(remove), () => ({}), "block");
    expect(blocked.performed).toEqual([]);
    expect(blocked.finished[0]).toMatchObject({ result: "skipped" });

    const allowed = await runForms(["FORM DELETE /clients/1"], inventoryOf(remove), () => ({ requests: [{ ...post(302), method: "DELETE", path: "/clients/1" }] }), "allow");
    expect(allowed.performed[0]).toMatchObject({ type: "submit", accept: true });
    expect(allowed.finished[0]).toMatchObject({ result: "pass" });
  });

  it("tallies every check under the user it ran as, and the form step says who it ran as", async () => {
    const { summary, started } = await runForms(["PAGE /clients", "FORM POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(500)] }), "allow");
    expect(summary.by_role).toEqual({ admin: { steps: 2, passed: 1, failed: 1, errors: 0, skipped: 0 } });
    const form = started.find((s) => s.key.includes("#FORM"));
    expect(form?.input).toMatchObject({ role: "admin", form: "FORM POST /clients" });
  });

  it("a form that refuses an empty submission passes: nothing is sent and the page says what is missing", async () => {
    const { summary, finished, performed, up } = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [], messages: ["client[name]: Preencha este campo."] }), "block");
    expect(summary).toMatchObject({ steps: 2, passed: 2, failed: 0 }); // the page, then the validation
    expect(finished[0]).toMatchObject({ result: "pass" });
    expect(finished[0]?.actual).toContain("Preencha este campo");
    expect(performed[0]).toMatchObject({ type: "submit", formRef: "f0", values: {} }); // nothing typed
    const body = JSON.parse(Object.values(up.bodies).find((b) => b.includes('"mode":"validate"')) as string) as { inputs: unknown[]; messages: string[]; required: string[] };
    expect(body.inputs).toEqual([]);
    expect(body.messages).toEqual(["client[name]: Preencha este campo."]);
    expect(body.required).toContain("client[name]");
  });

  it("a form that says nothing and sends nothing fails: the person is left without knowing what is missing", async () => {
    const { finished } = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [], messages: [] }), "block");
    expect(finished[0]).toMatchObject({ result: "fail" });
    expect(finished[0]?.actual).toMatch(/não mostrou o que falta/);
  });

  it("where writes are blocked and the page tried to send the empty form, it is skipped: the server's answer cannot be seen", async () => {
    const { finished } = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(null, true)] }), "block");
    expect(finished[0]).toMatchObject({ result: "skipped" });
    expect(finished[0]?.actual).toMatch(/não dá para saber se o servidor valida/);
  });

  it("where writes are allowed, a server that accepts the empty form fails; one that refuses it passes", async () => {
    const accepted = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(302)], navigatedTo: BASE + "/clients/9" }), "allow");
    expect(accepted.finished[0]).toMatchObject({ result: "fail" });
    expect(accepted.finished[0]?.actual).toMatch(/aceitou o envio vazio.*POST \/clients → 302/);
    const refused = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(422)] }), "allow");
    expect(refused.finished[0]).toMatchObject({ result: "pass" });
    expect(refused.finished[0]?.actual).toMatch(/recusou.*422/);
    const redisplayed = await runForms(["VALIDATE POST /clients"], inventoryOf(clientForm), () => ({ requests: [post(200)], messages: ["Nome não pode ficar em branco"] }), "allow");
    expect(redisplayed.finished[0]).toMatchObject({ result: "pass" });
  });

  it("a validation check of a form that is gone fails, and one of a form that ends the session is skipped", async () => {
    const gone = await runForms(["VALIDATE POST /clients"], inventoryOf(), () => ({}), "allow");
    expect(gone.finished[0]).toMatchObject({ result: "fail" });
    const logout = { ...clientForm, label: "Sair", submitLabel: "Sair", fields: [field("i0", "x", "text", true)] };
    const never = await runForms(["VALIDATE POST /clients"], inventoryOf(logout), () => ({}), "allow");
    expect(never.finished[0]).toMatchObject({ result: "skipped" });
    expect(never.performed).toEqual([]);
  });

  it("runs both the fill-in and the validation of the same form, as separate steps with their own evidence", async () => {
    const { started, finished } = await runForms(["FORM POST /clients", "VALIDATE POST /clients"], inventoryOf(clientForm), (a) => (a.type === "submit" && Object.keys(a.values).length === 0 ? { requests: [], messages: ["obrigatório"] } : { requests: [post(302)] }), "allow");
    expect(started.filter((s) => s.key.includes("#")).map((s) => s.input["form"])).toEqual(["FORM POST /clients", "VALIDATE POST /clients"]);
    expect(finished.map((f) => f.result)).toEqual(["pass", "pass"]);
  });

  it("is skipped when the session cannot interact (nothing to fill with)", async () => {
    const { finished } = await runForms(["FORM POST /clients"], null, () => ({}), "allow");
    expect(finished.find((f) => f.result === "skipped")?.actual).toMatch(/interag/i);
  });

  it("does not try forms of a page that is already failing", async () => {
    const { d } = driver({ "/clients": { status: 500 } });
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const summary = await runRegression({
      driver: d, sink, environment: { ...env, destructive_policy: "allow" }, credentials: creds, targets: [formTarget(["PAGE /clients", "FORM POST /clients"])], uploader: uploader(),
      budget: { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 }, shouldStop: () => false,
    });
    expect(summary).toMatchObject({ steps: 2, failed: 1, skipped: 1 });
  });
});
