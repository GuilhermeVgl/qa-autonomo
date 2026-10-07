import { describe, expect, it } from "vitest";
import { HttpUploader } from "./uploader.js";

describe("HttpUploader", () => {
  it("asks the control plane for an upload slot, PUTs the bytes there and returns the reference", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/artifacts")) {
        return new Response(JSON.stringify({ storage_key: "org/run/a.png", upload_url: "http://store.test/put/a.png?sig=1", expires_in: 600 }));
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const up = new HttpUploader("http://cp.test", "tok", "run-1", fetchFn);
    const ref = await up.upload("screenshot", "image/png", new Uint8Array([1, 2, 3]));

    expect(ref).toEqual({ kind: "screenshot", content_type: "image/png", storage_key: "org/run/a.png" });
    expect(calls[0]?.url).toBe("http://cp.test/runner/v1/jobs/run-1/artifacts");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "screenshot", content_type: "image/png" });
    expect(calls[1]?.url).toBe("http://store.test/put/a.png?sig=1");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(new Headers(calls[1]?.init?.headers).get("content-type")).toBe("image/png");
    // the storage upload carries no control-plane credentials
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBeNull();
  });

  it("fails when the slot is refused or the upload is rejected", async () => {
    const refuse = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(new HttpUploader("http://cp.test", "t", "r", refuse).upload("screenshot", "image/png", new Uint8Array())).rejects.toThrow(/503/);

    const rejectPut = (async (url: string) =>
      url.includes("/artifacts")
        ? new Response(JSON.stringify({ storage_key: "k", upload_url: "http://s/put" }))
        : new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(new HttpUploader("http://cp.test", "t", "r", rejectPut).upload("screenshot", "image/png", new Uint8Array())).rejects.toThrow(/403/);
  });
});
