import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explore, type LoginFailure } from "../src/agent/explorer.js";
import { runRegression } from "../src/agent/regression.js";
import { EventSink } from "../src/agent/sink.js";
import type { Job, RunnerEvent } from "../src/protocol/schemas.js";
import { BrowserDriver } from "../src/executors/browser/driver.js";

// Logins of the kind real applications have, against fixtures/sample-app (/lp, /two, /otp, /cap, /sso): the home page does
// not show the form, it is drawn late by a script, the first step asks only for the e-mail, a captcha, a code, single sign-on.
let server: Server;
let plain: Server;
let strict: Server;
let noisy: Server;
let base: string;
let plainBase: string;
let strictBase: string;
let noisyBase: string;
let otpSecret: string;

beforeAll(async () => {
  const file = fileURLToPath(new URL("../../fixtures/sample-app/server.mjs", import.meta.url));
  const app = (await import(pathToFileURL(file).href)) as { createApp(): Server; OTP_SECRET: string };
  otpSecret = app.OTP_SECRET;
  server = app.createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // an application with nothing to log into: a public page, and 404 everywhere else
  plain = createServer((req, res) => (req.url === "/" ? res.writeHead(200, { "content-type": "text/html" }).end("<h1>Público</h1><p>Sem login.</p>") : res.writeHead(404).end("não encontrado")));
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
  // a login that answers a refusal with a bare 401 page, with no form left on it to tell the story
  strict = createServer((req, res) => {
    if (req.method === "POST") return res.writeHead(401, { "content-type": "text/html" }).end("<h1>Acesso negado</h1>");
    res.writeHead(200, { "content-type": "text/html" }).end('<form method="post" action="/in"><input name="user"><input type="password" name="pw"><button type="submit">Entrar</button></form>');
  });
  await new Promise<void>((r) => strict.listen(0, "127.0.0.1", r));
  strictBase = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
  // login page that also loads blocked third-party assets (fonts/tag manager)
  noisy = createServer((req, res) => {
    if (req.method === "POST") return res.writeHead(200, { "content-type": "text/html" }).end('<form method="post" action="/in"><input name="user"><input type="password" name="pw"><p>Usuário ou senha inválidos.</p><button type="submit">Entrar</button></form>');
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto"><script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script></head><body><form method="post" action="/in"><input name="user"><input type="password" name="pw"><button type="submit">Entrar</button></form></body></html>',
      );
  });
  await new Promise<void>((r) => noisy.listen(0, "127.0.0.1", r));
  noisyBase = `http://127.0.0.1:${(noisy.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  plain.close();
  strict.close();
  noisy.close();
});

async function tryLogin(baseUrl: string, password = "segredo", hosts = ["127.0.0.1"], username = "ana") {
  const driver = await BrowserDriver.launch({ base_url: baseUrl, allowed_hosts: hosts });
  try {
    const session = await driver.newSession("ana", { app_role: "ana", kind: "login", payload: { username, password } });
    const failure: LoginFailure | undefined = driver.loginFailure("ana");
    return { session, failure, driver };
  } catch (err) {
    await driver.close();
    throw err;
  }
}

async function newSession(baseUrl: string, credential: Job["credentials"][number], hosts = ["127.0.0.1"]) {
  const driver = await BrowserDriver.launch({ base_url: baseUrl, allowed_hosts: hosts });
  try {
    const session = await driver.newSession(credential.app_role, credential);
    const failure: LoginFailure | undefined = driver.loginFailure(credential.app_role);
    return { session, failure, driver };
  } catch (err) {
    await driver.close();
    throw err;
  }
}

describe("logging in the way real applications ask for it", () => {
  it("finds the login behind an 'Entrar' link, waits for the script that draws it, and presses the button when Enter does nothing", async () => {
    const { session, failure, driver } = await tryLogin(base + "/lp");
    try {
      expect(failure).toBeUndefined();
      expect(session).not.toBeNull();
      // and it is really logged in: the home page now shows the logged area, and a page behind the login opens
      const home = await session?.visit(base + "/lp");
      expect(home?.links.some((l) => l.href.endsWith("/lp/app/pedidos"))).toBe(true);
      expect((await session?.visit(base + "/lp/app/pedidos"))?.url).toBe(base + "/lp/app/pedidos");
    } finally {
      await session?.close();
      await driver.close();
    }
  }, 60_000);

  it("goes through a first step that asks only for the e-mail", async () => {
    const { session, failure, driver } = await tryLogin(base + "/two", "segredo", ["127.0.0.1"], "ana@x.com");
    try {
      expect(failure).toBeUndefined();
      expect(session).not.toBeNull();
      expect((await session?.visit(base + "/two"))?.links.some((l) => l.href.endsWith("/two/app/pedidos"))).toBe(true);
    } finally {
      await session?.close();
      await driver.close();
    }
  }, 60_000);

  it("says the credentials were refused, with what the page said", async () => {
    const { session, failure, driver } = await tryLogin(base + "/lp", "errada");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("rejected");
    expect(failure?.message).toContain("Usuário ou senha inválidos");
  }, 60_000);

  it("refuses a second step with the wrong password, saying so", async () => {
    const { session, failure, driver } = await tryLogin(base + "/two", "errada", ["127.0.0.1"], "ana@x.com");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("rejected");
    expect(failure?.message).toContain("Senha incorreta");
  }, 60_000);

  it("takes a bare 401 page as a refusal, though the form is gone from it", async () => {
    const { session, failure, driver } = await tryLogin(strictBase + "/");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("rejected");
    expect(failure?.message).toContain("HTTP 401");
  }, 60_000);

  it("does not call it SSO when only third-party assets are blocked (fonts/tag manager)", async () => {
    const { session, failure, driver } = await tryLogin(noisyBase + "/", "errada");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("rejected");
    expect(failure?.message).not.toContain("hosts permitidos");
  }, 60_000);

  it("says a one-time code is in the way, instead of reporting a login that did not happen as a success", async () => {
    const { session, failure, driver } = await tryLogin(base + "/otp");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("needs_more");
    expect(failure?.message).toContain("2FA");
  }, 60_000);

  it("passes the one-time code (2FA) from a TOTP secret and gets in", async () => {
    const { session, failure, driver } = await newSession(base + "/otp", { app_role: "ana", kind: "login", payload: { username: "ana", password: "segredo", totp_secret: otpSecret } });
    try {
      expect(failure).toBeUndefined();
      expect(session).not.toBeNull();
      expect((await session?.visit(base + "/otp"))?.links.some((l) => l.href.includes("/otp/app"))).toBe(true);
    } finally {
      await session?.close();
      await driver.close();
    }
  }, 60_000);

  it("reuses a saved session (kind=session) and never performs the login", async () => {
    const state = JSON.stringify({ cookies: [{ name: "lp_session", value: "ok", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });
    const { session, failure, driver } = await newSession(base + "/lp", { app_role: "ana", kind: "session", payload: { state } });
    try {
      expect(failure).toBeUndefined();
      expect(session).not.toBeNull();
      expect((await session?.visit(base + "/lp"))?.links.some((l) => l.href.endsWith("/lp/app/pedidos"))).toBe(true);
    } finally {
      await session?.close();
      await driver.close();
    }
  }, 60_000);

  it("reports an expired session when the saved cookie no longer authenticates", async () => {
    const state = JSON.stringify({ cookies: [], origins: [] });
    const { session, failure, driver } = await newSession(base + "/lp", { app_role: "ana", kind: "session", payload: { state } });
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("session_expired");
    expect(failure?.message).toContain("recapture");
  }, 60_000);

  it("says a captcha is in the way", async () => {
    const { session, failure, driver } = await tryLogin(base + "/cap");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("needs_more");
    expect(failure?.message).toContain("captcha");
  }, 60_000);

  it("says the login goes through a site that is not allowed, naming it, when it is single sign-on", async () => {
    const { session, failure, driver } = await tryLogin(base + "/sso");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("sso_blocked");
    expect(failure?.message).toContain("login.example.invalid");
    expect(failure?.message).toContain("hosts permitidos");
  }, 60_000);

  it("does not pretend to be logged in when there is no login to be found: credentials were given, so it says it did not find the screen", async () => {
    const { session, failure, driver } = await tryLogin(plainBase + "/");
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("no_form");
    expect(failure?.message).toContain("não achei a tela de login");
  }, 60_000);

  it("says the application is not there when it does not answer", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { session, failure, driver } = await tryLogin(`http://127.0.0.1:${port}/`);
    await driver.close();
    expect(session).toBeNull();
    expect(failure?.reason).toBe("unreachable");
  }, 60_000);
});


describe("a run that cannot get in, or whose application is down, reports that and nothing else", () => {
  const budget = { max_pages: 20, max_depth: 3, max_seconds: 60, max_llm_calls: 0 };

  it("an exploration with a wrong password maps nothing and says why, with what the screen said", async () => {
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const env = { base_url: base + "/lp", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" as const };
    const driver = await BrowserDriver.launch(env);
    try {
      const summary = await explore({ driver, sink, environment: env, credentials: [{ app_role: "ana", kind: "login", payload: { username: "ana", password: "errada" } }], budget, shouldStop: () => false });
      expect(summary.pages).toBe(0);
      expect(summary.stopped_by).toBe("blocked");
      expect(summary.blocked?.kind).toBe("login_failed");
      expect(summary.blocked?.message).toContain("Usuário ou senha inválidos");
      expect(events.filter((e) => e.type === "node_discovered")).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 90_000);

  it("a regression of an application that is down tests nothing and reports no failures", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const url = `http://127.0.0.1:${port}`;
    const events: RunnerEvent[] = [];
    const sink = new EventSink(async (e) => void events.push(...e));
    const env = { base_url: url + "/", allowed_hosts: ["127.0.0.1"], destructive_policy: "block" as const };
    const targets: NonNullable<Job["targets"]> = [1, 2, 3].map((n) => ({ node_id: `00000000-0000-0000-0000-00000000000${n}`, fingerprint: `fp${n}`, url: `${url}/p${n}`, label: `/p${n}`, app_role: "anonymous", requirement_keys: [] }));
    const driver = await BrowserDriver.launch(env);
    try {
      const summary = await runRegression({
        driver, sink, environment: env, credentials: [], targets,
        uploader: { upload: async (k, ct) => ({ kind: k as "screenshot", content_type: ct, storage_key: "k" }) },
        budget, shouldStop: () => false, retryDelayMs: 0,
      });
      expect(summary.blocked?.kind).toBe("app_down");
      expect(summary.blocked?.message).toContain("conexão recusada");
      expect(summary).toMatchObject({ steps: 0, failed: 0, errors: 0, stopped_by: "blocked" });
      expect(events.filter((e) => e.type === "step_started" || e.type === "step_finished")).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 90_000);
});
