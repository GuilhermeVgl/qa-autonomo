import { describe, expect, it } from "vitest";
import { SSEParser, streamEvents } from "./sse";

describe("SSEParser", () => {
  it("parses events split across chunks", () => {
    const p = new SSEParser();
    expect(p.push("event: ready\nda")).toEqual([]);
    expect(p.push("ta: {}\n\nevent: graph_changed\ndata: {}\n\n")).toEqual([
      { event: "ready", data: "{}" },
      { event: "graph_changed", data: "{}" },
    ]);
  });

  it("ignores comments (keepalive) and handles CRLF", () => {
    const p = new SSEParser();
    expect(p.push(": keepalive\n\n")).toEqual([]);
    expect(p.push("event: x\r\ndata: 1\r\n\r\n")).toEqual([{ event: "x", data: "1" }]);
  });

  it("defaults the event name to message", () => {
    expect(new SSEParser().push("data: hi\n\n")).toEqual([{ event: "message", data: "hi" }]);
  });
});

describe("streamEvents", () => {
  it("sends the bearer token and delivers events until the stream ends", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: graph_changed\ndata: {}\n\n"));
        c.close();
      },
    });
    let seenAuth = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization") ?? "";
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const got: string[] = [];
    await streamEvents("/x", "tok", (e) => got.push(e.event), new AbortController().signal, fetchFn);
    expect(seenAuth).toBe("Bearer tok");
    expect(got).toEqual(["graph_changed"]);
  });

  it("throws on non-200", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(streamEvents("/x", "t", () => {}, new AbortController().signal, fetchFn)).rejects.toThrow(/401/);
  });
});
