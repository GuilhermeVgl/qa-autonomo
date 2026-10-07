import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserDriver } from "../src/executors/browser/driver.js";

// A login like Rails + Turbo / SPAs do it: the form is submitted with fetch and the page is swapped in place, so no
// navigation and no new `load` event happen. The driver must still tell success from failure.
const LOGIN_PAGE = `<!doctype html><body><form id="f"><input type="email" name="email"><input type="password" name="password">
<button type="submit">Entrar</button></form><p id="err"></p>
<script>
document.getElementById("f").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const res = await fetch("/session", { method: "POST", body: new URLSearchParams(new FormData(ev.target)) });
  await new Promise((r) => setTimeout(r, 400));
  if (res.ok) document.body.innerHTML = '<h1>Clientes</h1><a href="/clients">Clientes</a>';
  else document.getElementById("err").textContent = "E-mail ou senha inválidos.";
});
</script></body>`;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/session") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const ok = new URLSearchParams(body).get("password") === "segredo";
        res.writeHead(ok ? 200 : 401).end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(LOGIN_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => server.close());

async function sessionWith(password: string) {
  const driver = await BrowserDriver.launch({ base_url: base, allowed_hosts: ["127.0.0.1"] });
  try {
    const session = await driver.newSession("advogado", { app_role: "advogado", kind: "login", payload: { username: "ana@x.com", password } });
    await session?.close();
    return session;
  } finally {
    await driver.close();
  }
}

describe("login without a page load (Turbo/SPA)", () => {
  it("accepts correct credentials even though the page is swapped in place", async () => {
    expect(await sessionWith("segredo")).not.toBeNull();
  });

  it("rejects wrong credentials", async () => {
    expect(await sessionWith("errada")).toBeNull();
  });
});
