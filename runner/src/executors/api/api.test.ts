import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callEndpoint, checkContract, type EndpointTarget } from "./api.js";

let server: Server | undefined;
afterEach(() => server?.close());

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
}

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; host: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  server = srv;
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, host: "127.0.0.1", seen };
}

const json = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const target = (over: Partial<EndpointTarget> = {}): EndpointTarget => ({
  method: "GET",
  path: "/orders/42",
  query: {},
  status: 200,
  schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
  body_required: false,
  ...over,
});

const policy = "block" as const;

describe("callEndpoint + checkContract", () => {
  it("passes when status and body match the contract, sending path, query and bearer token", async () => {
    const { base, host, seen } = await start((_req, res) => json(res, 200, { id: 42 }));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ query: { page: "1" } }), token: "tok", policy });
    expect(out.kind).toBe("response");
    if (out.kind !== "response") return;
    expect(checkContract(target(), out.response)).toEqual({ result: "pass", actual: "HTTP 200, body matches the contract" });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/orders/42?page=1", auth: "Bearer tok" });
  });

  it("fails with the status when it differs from the contract", async () => {
    const { base, host } = await start((_req, res) => json(res, 500, { error: "boom" }));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy });
    if (out.kind !== "response") throw new Error("expected a response");
    const v = checkContract(target(), out.response);
    expect(v.result).toBe("fail");
    expect(v.actual).toContain("HTTP 500");
  });

  it("fails on a schema violation and says where", async () => {
    const { base, host } = await start((_req, res) => json(res, 200, { id: "not-a-number" }));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy });
    if (out.kind !== "response") throw new Error("expected a response");
    const v = checkContract(target(), out.response);
    expect(v.result).toBe("fail");
    expect(v.actual).toMatch(/\/id/);
  });

  it("fails when a body is required by the schema but the answer is not JSON", async () => {
    const { base, host } = await start((_req, res) => json(res, 200, "<html>oops</html>", "text/html"));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy });
    if (out.kind !== "response") throw new Error("expected a response");
    expect(checkContract(target(), out.response)).toMatchObject({ result: "fail" });
    const bad = await start((_req, res) => json(res, 200, "{not json", "application/json"));
    const out2 = await callEndpoint({ baseUrl: bad.base, allowedHosts: [bad.host], target: target(), policy });
    if (out2.kind !== "response") throw new Error("expected a response");
    expect(checkContract(target(), out2.response).actual).toMatch(/JSON/);
  });

  it("only checks the status when the contract has no schema", async () => {
    const { base, host } = await start((_req, res) => json(res, 204, ""));
    const t = target({ status: 204, schema: undefined });
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: t, policy });
    if (out.kind !== "response") throw new Error("expected a response");
    expect(checkContract(t, out.response).result).toBe("pass");
  });

  it("does not follow redirects (the destination could be out of scope)", async () => {
    const { base, host, seen } = await start((_req, res) => {
      res.writeHead(302, { location: "http://evil.example.org/x" });
      res.end();
    });
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy });
    if (out.kind !== "response") throw new Error("expected a response");
    expect(out.response.status).toBe(302);
    expect(checkContract(target(), out.response).result).toBe("fail");
    expect(seen).toHaveLength(1);
  });

  it("works with a base URL that has a path prefix", async () => {
    const { base, host, seen } = await start((_req, res) => json(res, 200, { id: 1 }));
    await callEndpoint({ baseUrl: base + "/api/v1/", allowedHosts: [host], target: target(), policy });
    expect(seen[0]?.url).toBe("/api/v1/orders/42");
  });

  it("never calls hosts outside allowed_hosts", async () => {
    const { base, seen } = await start((_req, res) => json(res, 200, {}));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: ["only-this.test"], target: target(), policy });
    expect(out).toMatchObject({ kind: "skipped" });
    expect(seen).toHaveLength(0);
  });

  it("skips mutating calls unless the environment allows destructive actions", async () => {
    const { base, host, seen } = await start((_req, res) => json(res, 201, {}));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ method }), policy: "block" });
      expect(out).toMatchObject({ kind: "skipped" });
    }
    const confirm = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ method: "DELETE" }), policy: "confirm" });
    expect(confirm.kind).toBe("skipped");
    expect(seen).toHaveLength(0);

    const allowed = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ method: "DELETE", status: 201 }), policy: "allow" });
    expect(allowed.kind).toBe("response");
  });

  it("skips operations that need a request body even when destructive calls are allowed", async () => {
    const { base, host, seen } = await start((_req, res) => json(res, 201, {}));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ method: "POST", body_required: true }), policy: "allow" });
    expect(out).toMatchObject({ kind: "skipped" });
    expect(seen).toHaveLength(0);
  });

  it("reports a network failure as an error, not a failed contract", async () => {
    const { base, host } = await start((_req, res) => json(res, 200, {}));
    server?.close();
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy });
    expect(out.kind).toBe("error");
  });

  it("times out slow endpoints", async () => {
    const { base, host } = await start(() => {
      /* never answers */
    });
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target(), policy, timeoutMs: 50 });
    expect(out.kind).toBe("error");
  });

  it("caps the response body it keeps", async () => {
    const { base, host } = await start((_req, res) => json(res, 200, "x".repeat(3_000_000), "text/plain"));
    const out = await callEndpoint({ baseUrl: base, allowedHosts: [host], target: target({ schema: undefined }), policy });
    if (out.kind !== "response") throw new Error("expected a response");
    expect(out.response.body.length).toBeLessThanOrEqual(1_048_576);
    expect(out.response.truncated).toBe(true);
  });
});
