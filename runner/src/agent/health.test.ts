import { describe, expect, it } from "vitest";
import { confirmDown, isGatewayStatus, isInfraMessage, reachable } from "./health.js";

const ok = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;
const fails = (cause: string) =>
  (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: cause } });
  }) as unknown as typeof fetch;

describe("isInfraMessage", () => {
  it.each([
    "net::ERR_CONNECTION_REFUSED at http://app.test/",
    "page.goto: net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_CONNECTION_TIMED_OUT",
    "net::ERR_INTERNET_DISCONNECTED",
    "connect ECONNREFUSED 127.0.0.1:3000",
    "getaddrinfo ENOTFOUND app.internal",
    "net::ERR_EMPTY_RESPONSE",
    "net::ERR_SSL_PROTOCOL_ERROR",
  ])("is the network, not the page: %s", (m) => expect(isInfraMessage(m)).toBe(true));

  it.each(["Timeout 15000ms exceeded.", "locator.click: Element is not visible", "TypeError: x is undefined", "HTTP 500"])("is not evidence by itself: %s", (m) => expect(isInfraMessage(m)).toBe(false));
});

describe("isGatewayStatus", () => {
  it("is what a proxy says when the application behind it is gone", () => {
    for (const s of [502, 503, 504]) expect(isGatewayStatus(s)).toBe(true);
    for (const s of [200, 301, 401, 403, 404, 500]) expect(isGatewayStatus(s)).toBe(false);
  });
});

describe("reachable", () => {
  it("is up when the application answers anything but a gateway error, even an error page of its own", async () => {
    for (const s of [200, 302, 401, 403, 404, 500]) expect((await reachable("http://a/", ok(s))).up, String(s)).toBe(true);
  });

  it("is down when nothing answers or a proxy says the application is gone, and says why", async () => {
    expect(await reachable("http://a/", fails("ECONNREFUSED"))).toEqual({ up: false, detail: "conexão recusada (ECONNREFUSED)" });
    expect((await reachable("http://a/", fails("ENOTFOUND"))).detail).toContain("endereço não encontrado");
    expect(await reachable("http://a/", ok(503))).toEqual({ up: false, detail: "o servidor respondeu HTTP 503" });
  });

  it("never follows a redirect: where the application sends you is not what is being asked", async () => {
    let seen: RequestInit | undefined;
    await reachable("http://a/", (async (_u: string, init?: RequestInit) => ((seen = init), new Response("", { status: 200 }))) as unknown as typeof fetch);
    expect(seen?.redirect).toBe("manual");
  });
});

describe("confirmDown", () => {
  it("is down only when every try finds it down", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? Promise.reject(new TypeError("fetch failed")) : new Response("", { status: 200 }))) as unknown as typeof fetch;
    expect((await confirmDown("http://a/", { fetchFn: flaky, attempts: 2, gapMs: 0 })).down).toBe(false);
    expect((await confirmDown("http://a/", { fetchFn: fails("ECONNREFUSED"), attempts: 2, gapMs: 0 })).down).toBe(true);
  });
});
