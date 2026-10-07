import { describe, expect, it } from "vitest";
import type { ArtifactRef, RunnerEvent } from "../protocol/schemas.js";
import { EventSink } from "../agent/sink.js";
import { SecurityScan, newScanShare } from "./scan.js";
import { EVIL_ORIGIN, REDIRECT_TARGET, injection } from "./probes.js";
import type { CookieFlag, PageFacts, ProbeOutcome, RawResponse, SecurityCapabilities } from "./types.js";

const good = { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "strict-transport-security": "x" };
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ headers: good, html: true, forms: [], metaCsrf: false, mixed: [], text: "ok", ...over });
const page = (path: string, f: PageFacts, status = 200) => ({ url: `https://app.test${path}`, status, security: f });

type Started = Extract<RunnerEvent, { type: "step_started" }>["payload"];
type Finished = Extract<RunnerEvent, { type: "step_finished" }>["payload"];

function harness(opts: { role?: string; maxProbes?: number; withUploader?: boolean; share?: ReturnType<typeof newScanShare>; executor?: "browser" | "mobile_web"; baseUrl?: string } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const uploads: { kind: string; body: unknown }[] = [];
  const uploader = opts.withUploader === false ? undefined : {
    upload: async (kind: string, _ct: string, bytes: Uint8Array): Promise<ArtifactRef> => {
      uploads.push({ kind, body: JSON.parse(new TextDecoder().decode(bytes)) });
      return { kind: kind as ArtifactRef["kind"], content_type: "application/json", storage_key: `k${uploads.length}` };
    },
  };
  const scan = new SecurityScan({
    sink,
    uploader,
    environment: { base_url: opts.baseUrl ?? "https://app.test/", allowed_hosts: ["app.test"] },
    executor: opts.executor ?? "browser",
    role: opts.role ?? "admin",
    share: opts.share ?? newScanShare(),
    ...(opts.maxProbes !== undefined ? { maxProbes: opts.maxProbes } : {}),
  });
  const steps = async () => {
    await sink.flush();
    const started = events.flatMap((e) => (e.type === "step_started" ? [e.payload] : []));
    const finished = new Map(events.flatMap((e) => (e.type === "step_finished" ? [[e.payload.key, e.payload] as [string, Finished]] : [])));
    return started.map((s: Started) => ({ ...s, ...(finished.get(s.key) as Finished) }));
  };
  return { scan, steps, uploads };
}

const home = { fingerprint: "fp-home" };

describe("SecurityScan: what every screen should have", () => {
  it("folds a header missing on many screens into one failing step and says which screens in its evidence", async () => {
    const { scan, steps, uploads } = harness();
    const bare = facts({ headers: { ...good, "content-security-policy": "" } });
    scan.page(page("/", bare), home, "/");
    scan.page(page("/orders", bare), { fingerprint: "fp-orders" }, "/orders");
    scan.page(page("/customers", facts()), { fingerprint: "fp-customers" }, "/customers");
    await scan.finish();
    const all = await steps();
    const csp = all.find((s) => s.security?.check === "header-csp");
    expect(csp).toMatchObject({ result: "fail", node_fingerprint: "fp-home", security: { check: "header-csp", severity: "normal" }, actual: "Content-Security-Policy ausente nas respostas da aplicação" });
    expect(all.filter((s) => s.security?.check === "header-csp")).toHaveLength(1);
    expect(csp?.key).toBe("SEC header-csp @admin");
    expect(csp?.artifacts).toHaveLength(1);
    expect(uploads[0]?.body).toMatchObject({ check: "header-csp", routes: ["/", "/orders"], checked: 3 });
  });

  it("reports the checks that held as passes, so a fixed problem can be seen to be fixed", async () => {
    const { scan, steps } = harness();
    scan.page(page("/", facts()), home, "/");
    await scan.finish();
    const all = await steps();
    expect(all.find((s) => s.security?.check === "header-frame")).toMatchObject({ result: "pass" });
    expect(all.every((s) => s.result === "pass")).toBe(true);
  });

  it("emits nothing for a check that never got to look", async () => {
    const { scan, steps } = harness();
    await scan.finish();
    expect(await steps()).toEqual([]);
  });

  it("names the step by the user, so each user's pass or failure is their own, and keeps the bug the same for both", async () => {
    const share = newScanShare();
    const a = harness({ role: "admin", share });
    const b = harness({ role: "operador", share });
    a.scan.page(page("/", facts({ headers: {} })), home, "/");
    b.scan.page(page("/", facts({ headers: {} })), { fingerprint: "fp-home-op" }, "/");
    await a.scan.finish();
    await b.scan.finish();
    const [sa, sb] = [(await a.steps()).find((s) => s.security?.check === "header-csp"), (await b.steps()).find((s) => s.security?.check === "header-csp")];
    expect(sa?.key).toBe("SEC header-csp @admin");
    expect(sb?.key).toBe("SEC header-csp @operador");
    expect(sa?.security).toEqual(sb?.security); // the server dedupes by check and scope: one bug, two users
  });

  it("anchors by id in a regression, where the screens are known by id", async () => {
    const { scan, steps } = harness();
    scan.page(page("/", facts({ headers: {} })), { id: "0198c1f0-0000-7000-8000-000000000009" }, "/");
    await scan.finish();
    const s = (await steps()).find((x) => x.security?.check === "header-csp");
    expect(s?.node_id).toBe("0198c1f0-0000-7000-8000-000000000009");
    expect(s?.node_fingerprint).toBeUndefined();
  });

  it("marks the steps of a mobile environment as such", async () => {
    const { scan, steps } = harness({ executor: "mobile_web" });
    scan.page(page("/", facts()), home, "/");
    await scan.finish();
    expect((await steps())[0]?.executor).toBe("mobile_web");
  });

  it("works without somewhere to keep evidence", async () => {
    const { scan, steps } = harness({ withUploader: false });
    scan.page(page("/", facts({ headers: {} })), home, "/");
    await scan.finish();
    const s = (await steps()).find((x) => x.security?.check === "header-csp");
    expect(s?.result).toBe("fail");
    expect(s?.artifacts).toBeUndefined();
  });

  it("counts what it found", async () => {
    const { scan } = harness();
    scan.page(page("/", facts({ headers: {} })), home, "/");
    await scan.finish();
    const sum = scan.summary();
    expect(sum.failed).toBeGreaterThanOrEqual(4);
    expect(sum.checks).toBeGreaterThan(sum.failed - 1);
    expect(sum.by_severity.normal).toBeGreaterThan(0);
  });
});

describe("SecurityScan: cookies and CSRF", () => {
  const cookie = (over: Partial<CookieFlag>): CookieFlag => ({ name: "_app_session", httpOnly: true, secure: true, sameSite: "lax", ...over });
  const form = { method: "POST", action: "https://app.test/orders", label: "Novo", hidden: [], fields: [{ name: "n", type: "text" }], password: false };

  it("fails the cookie that lacks its flags, named by the cookie", async () => {
    const { scan, steps } = harness();
    scan.cookies([cookie({ httpOnly: false })], home);
    await scan.finish();
    const s = (await steps()).find((x) => x.security?.check === "cookie-httponly");
    expect(s).toMatchObject({ result: "fail", security: { check: "cookie-httponly", severity: "high", scope: "_app_session" }, actual: 'Cookie de sessão "_app_session" sem HttpOnly (um script injetado consegue roubá-lo)' });
  });

  it("lets what the session cookie says about SameSite decide whether a form without a token is exposed", async () => {
    const lax = harness();
    lax.scan.cookies([cookie({ sameSite: "lax" })], home);
    lax.scan.page(page("/", facts({ forms: [form] })), home, "/");
    await lax.scan.finish();
    expect((await lax.steps()).find((s) => s.security?.check === "csrf-token")?.result).toBe("pass");

    const none = harness();
    none.scan.cookies([cookie({ sameSite: "none" })], home);
    none.scan.page(page("/", facts({ forms: [form] })), home, "/");
    await none.scan.finish();
    expect((await none.steps()).find((s) => s.security?.check === "csrf-token")).toMatchObject({ result: "fail", security: { severity: "high", scope: "POST /orders" } });
  });
});

describe("SecurityScan: injections", () => {
  /** A session that answers each probe as a function of the address asked for. */
  const session = (answer: (url: URL) => Partial<ProbeOutcome> | null, raw?: (url: URL, o?: { origin?: string }) => Partial<RawResponse> | null): SecurityCapabilities & { probed: string[]; raws: string[] } => {
    const probed: string[] = [];
    const raws: string[] = [];
    return {
      probed,
      raws,
      probe: async (u) => {
        probed.push(u);
        const a = answer(new URL(u));
        return a === null ? null : { status: 200, finalUrl: u, injected: [], text: "Resultados", ...a };
      },
      rawGet: async (u, o) => {
        raws.push(u);
        const r = raw?.(new URL(u), o) ?? { status: 404 };
        return r === null ? null : { status: 404, headers: {}, body: "", ...r };
      },
    };
  };
  const searchPage = (path = "/search?q=x") => page(path, facts());

  it("tries each parameter and fails the one whose marker became markup, passing the others", async () => {
    const { scan, steps } = harness();
    const s = session((u) => ({ injected: u.searchParams.get("q") === injection(0) ? [0] : [] }));
    await scan.probe(s, page("/search?q=x&page=2", facts()), home, "/search");
    await scan.finish();
    const all = (await steps()).filter((x) => x.security?.check === "xss-reflected");
    expect(all.map((x) => [x.security?.scope, x.result])).toEqual([["/search?q", "fail"], ["/search?page", "pass"]]);
    expect(all[0]).toMatchObject({ actual: "XSS refletido: o parâmetro q de /search volta na página sem escape", security: { severity: "high" }, node_fingerprint: "fp-home" });
    expect(s.probed).toHaveLength(1); // one request tries every parameter at once
  });

  it("calls an SQL error after the quote a possible injection, and confirms it is not there on an ordinary value", async () => {
    const { scan, steps } = harness();
    const s = session((u) => (u.searchParams.get("q") === "1" ? {} : { status: 500, text: "You have an error in your SQL syntax near ''" }));
    await scan.probe(s, searchPage(), home, "/search");
    await scan.finish();
    const all = await steps();
    expect(all.find((x) => x.security?.check === "sqli-error")).toMatchObject({ result: "fail", security: { severity: "critical", scope: "/search?q" } });
    expect(all.find((x) => x.security?.check === "injection-500")?.result).toBe("pass"); // the database error explains it
    expect(s.probed).toHaveLength(2); // the injection and the ordinary value
  });

  it("does not blame the injection for an error the page shows on any value", async () => {
    const { scan, steps } = harness();
    await scan.probe(session(() => ({ status: 500, text: "ORA-00933: SQL command not properly ended" })), searchPage(), home, "/search");
    await scan.finish();
    const all = await steps();
    expect(all.find((x) => x.security?.check === "sqli-error")?.result).toBe("pass");
    expect(all.find((x) => x.security?.check === "injection-500")?.result).toBe("pass");
  });

  it("notes a server error that only the injection causes", async () => {
    const { scan, steps } = harness();
    await scan.probe(session((u) => (u.searchParams.get("q") === "1" ? {} : { status: 500, text: "Internal Server Error" })), searchPage(), home, "/search");
    await scan.finish();
    expect((await steps()).find((x) => x.security?.check === "injection-500")).toMatchObject({ result: "fail", security: { severity: "normal", scope: "/search?q" } });
  });

  it("tries the same route and parameters once, however many pages show them", async () => {
    const { scan } = harness();
    const s = session(() => ({}));
    await scan.probe(s, searchPage("/orders/1?q=a"), home, "/orders/:id");
    await scan.probe(s, searchPage("/orders/2?q=b"), home, "/orders/:id");
    expect(s.probed).toHaveLength(1);
  });

  it("stops at its limit of probes", async () => {
    const { scan } = harness({ maxProbes: 2 });
    const s = session(() => ({}));
    for (const p of ["/a", "/b", "/c", "/d"]) await scan.probe(s, searchPage(`${p}?q=x`), home, p);
    expect(s.probed).toHaveLength(2);
  });

  it("skips a probe the session could not make, and does nothing with a session that cannot probe", async () => {
    const { scan, steps } = harness();
    await scan.probe(session(() => null), searchPage(), home, "/search");
    await scan.probe({}, searchPage("/other?q=1"), home, "/other");
    await scan.finish();
    expect((await steps()).filter((x) => x.security?.check === "xss-reflected")).toEqual([]);
  });

  it("probes what the regression knows about a screen", async () => {
    const { scan } = harness();
    const s = session(() => ({}));
    await scan.probe(s, page("/orders", facts()), { id: "n1" }, "/orders", [{ url: "https://app.test/orders", params: ["q"] }]);
    expect(s.probed).toHaveLength(1);
    expect(new URL(s.probed[0] as string).searchParams.get("q")).toBe(injection(0));
  });

  it("asks a redirect parameter to send the person to a site that is not the application's", async () => {
    const { scan, steps } = harness();
    const s = session(
      () => ({}),
      (u) => (u.searchParams.get("next") === REDIRECT_TARGET ? { status: 302, headers: { location: REDIRECT_TARGET } } : { status: 200 }),
    );
    await scan.probe(s, page("/login?next=%2Forders", facts()), home, "/login");
    await scan.finish();
    expect((await steps()).find((x) => x.security?.check === "open-redirect")).toMatchObject({ result: "fail", security: { severity: "normal", scope: "/login?next" } });
  });
});

describe("SecurityScan: the checks of the environment", () => {
  const files = (found: Record<string, string>) => async (u: string): Promise<RawResponse | null> => {
    const path = new URL(u).pathname;
    return path in found ? { status: 200, headers: { "content-type": "text/plain" }, body: found[path] as string } : { status: 404, headers: {}, body: "" };
  };

  it("looks for exposed files and CORS once for the whole run, not once per user", async () => {
    const share = newScanShare();
    const calls: string[] = [];
    const caps: SecurityCapabilities = { rawGet: async (u) => (calls.push(u), { status: 404, headers: {}, body: "" }) };
    const a = harness({ role: "admin", share });
    const b = harness({ role: "operador", share });
    await a.scan.environment(caps, home);
    const after = calls.length;
    await b.scan.environment(caps, home);
    expect(after).toBeGreaterThan(5);
    expect(calls.length).toBe(after);
  });

  it("fails an exposed file with the severity of that file, and passes the others", async () => {
    const { scan, steps } = harness();
    await scan.environment({ rawGet: files({ "/.env": "DB_PASSWORD=secret\n" }) }, home);
    await scan.finish();
    const all = (await steps()).filter((s) => s.security?.check === "exposed-file");
    expect(all.find((s) => s.security?.scope === "/.env")).toMatchObject({ result: "fail", security: { severity: "critical" }, actual: "Arquivo sensível exposto: /.env" });
    expect(all.find((s) => s.security?.scope === "/.git/HEAD")?.result).toBe("pass");
  });

  it("fails CORS that accepts an origin it was never told about, with credentials", async () => {
    const { scan, steps } = harness();
    const caps: SecurityCapabilities = {
      rawGet: async (_u, o): Promise<RawResponse> => (o?.origin ? { status: 200, headers: { "access-control-allow-origin": o.origin, "access-control-allow-credentials": "true" }, body: "" } : { status: 404, headers: {}, body: "" }),
    };
    await scan.environment(caps, home);
    await scan.finish();
    expect((await steps()).find((s) => s.security?.check === "cors-reflect")?.result).toBe("fail");
    expect(EVIL_ORIGIN).toContain("invalid");
  });

  it("says a site served without https is exposed, unless it is on a developer's machine", async () => {
    const exposed = harness({ baseUrl: "http://app.kpmg.example/" });
    await exposed.scan.environment({ rawGet: async () => null }, home);
    await exposed.scan.finish();
    expect((await exposed.steps()).find((s) => s.security?.check === "transport-http")).toMatchObject({ result: "fail", security: { severity: "high" } });

    const local = harness({ baseUrl: "http://localhost:3000/" });
    await local.scan.environment({ rawGet: async () => null }, home);
    await local.scan.finish();
    expect((await local.steps()).find((s) => s.security?.check === "transport-http")).toBeUndefined();
  });
});

describe("SecurityScan: keys", () => {
  it("keeps keys and scopes within what the server takes", async () => {
    const { scan, steps } = harness();
    const long = "/" + "a".repeat(400);
    scan.cookies([{ name: "x".repeat(300) + "_session", httpOnly: false, secure: true, sameSite: "lax" }], home);
    void long;
    await scan.finish();
    for (const s of await steps()) {
      expect(s.key.length).toBeLessThanOrEqual(190);
      expect((s.security?.scope ?? "").length).toBeLessThanOrEqual(200);
    }
  });
});
