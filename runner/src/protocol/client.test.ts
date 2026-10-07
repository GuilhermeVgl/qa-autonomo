import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneClient } from "./client.js";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let server: Server | undefined;
afterEach(() => server?.close());

async function start(handler: (seen: Seen) => { status: number; body?: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      seen.push(s);
      const out = handler(s);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  server = srv;
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

const job = {
  run_id: "0198c1f0-0000-7000-8000-000000000001",
  attempt: 1,
  graph_id: "0198c1f0-0000-7000-8000-000000000002",
  type: "exploration",
  budget: { max_pages: 5, max_depth: 2, max_seconds: 30 },
  environment: { base_url: "http://app.test", allowed_hosts: ["app.test"], destructive_policy: "block" },
  credentials: [{ app_role: "admin", kind: "login", payload: { username: "a", password: "b" } }],
};

describe("ControlPlaneClient", () => {
  it("registers with the bootstrap token and returns the runner token", async () => {
    const { url, seen } = await start(() => ({ status: 200, body: { runner_id: "r1", token: "qar_x" } }));
    const token = await ControlPlaneClient.register(url, { bootstrapToken: "boot", name: "r", labels: ["browser"], version: "1" });
    expect(token).toBe("qar_x");
    expect(seen[0]?.url).toBe("/runner/v1/register");
    expect(seen[0]?.body).toMatchObject({ bootstrap_token: "boot", name: "r", labels: ["browser"] });
  });

  it("leases a job (validated) and sends the bearer token", async () => {
    const { url, seen } = await start(() => ({ status: 200, body: job }));
    const got = await new ControlPlaneClient(url, "tok").lease(1500);
    expect(got?.run_id).toBe(job.run_id);
    expect(seen[0]?.url).toBe("/runner/v1/jobs/lease?wait=1500");
    expect(seen[0]?.auth).toBe("Bearer tok");
  });

  it("returns null when there is no job (204)", async () => {
    const { url } = await start(() => ({ status: 204 }));
    expect(await new ControlPlaneClient(url, "tok").lease(0)).toBeNull();
  });

  it("accepts a job for a mobile web environment (device)", async () => {
    const { url } = await start(() => ({ status: 200, body: { ...job, environment: { ...job.environment, device: "iPhone 13" } } }));
    const got = await new ControlPlaneClient(url, "tok").lease(0);
    expect(got?.environment.device).toBe("iPhone 13");
  });

  it("rejects a malformed job from the server", async () => {
    const { url } = await start(() => ({ status: 200, body: { ...job, type: "teleport" } }));
    await expect(new ControlPlaneClient(url, "tok").lease(0)).rejects.toThrow();
  });

  it("sends events, heartbeat and complete to the job endpoints", async () => {
    const { url, seen } = await start((s) => (s.url.endsWith("/heartbeat") ? { status: 200, body: { cancel: true } } : { status: 200, body: {} }));
    const c = new ControlPlaneClient(url, "tok");
    await c.sendEvents(job.run_id, [{ seq: 1, type: "node_discovered", payload: { fingerprint: "f", kind: "page", label: "/" } }]);
    expect(await c.heartbeat(job.run_id)).toEqual({ cancel: true });
    await c.complete(job.run_id, "succeeded", { pages: 1 });
    expect(seen.map((s) => s.url)).toEqual([
      `/runner/v1/jobs/${job.run_id}/events`,
      `/runner/v1/jobs/${job.run_id}/heartbeat`,
      `/runner/v1/jobs/${job.run_id}/complete`,
    ]);
    expect(seen[2]?.body).toEqual({ status: "succeeded", summary: { pages: 1 } });
  });

  it("chats through the gateway with the run id and task headers", async () => {
    let headers: Record<string, string | string[] | undefined> = {};
    const { url, seen } = await start(() => ({ status: 200, body: { choices: [{ message: { content: '{"order":[0]}' } }] } }));
    // capture headers via a second server handler
    server?.removeAllListeners("request");
    server?.on("request", (req, res) => {
      headers = req.headers;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"order":[0]}' } }] }));
      });
    });
    const out = await new ControlPlaneClient(url, "tok").chat(job.run_id, [{ role: "user", content: "hi" }]);
    expect(out).toBe('{"order":[0]}');
    expect(headers["x-qa-run-id"]).toBe(job.run_id);
    expect(headers["x-qa-task"]).toBe("explore");
    expect(seen[0]?.url).toBe("/runner/v1/llm/chat/completions");
    expect(seen[0]?.body).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
  });

  it("throws on error statuses without leaking the response body", async () => {
    const { url } = await start(() => ({ status: 409, body: { error: "run is not running" } }));
    await expect(new ControlPlaneClient(url, "tok").sendEvents(job.run_id, [])).rejects.toThrow(/409/);
  });
});
