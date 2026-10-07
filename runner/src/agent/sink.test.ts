import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEvent } from "../protocol/schemas.js";
import { EventSink } from "./sink.js";

describe("EventSink", () => {
  it("assigns increasing seq starting at 1 and flushes explicitly", async () => {
    const sent: RunnerEvent[][] = [];
    const sink = new EventSink(async (evs) => void sent.push(evs), 100);
    sink.node({ fingerprint: "a", kind: "page", label: "/" });
    sink.edge({ key: "k", from_fingerprint: "a", to_fingerprint: "b", action: {} });
    expect(sent).toHaveLength(0);
    await sink.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((e) => e.seq)).toEqual([1, 2]);
    expect(sent[0]?.map((e) => e.type)).toEqual(["node_discovered", "edge_discovered"]);
  });

  it("flushes automatically when the batch is full", async () => {
    const sent: RunnerEvent[][] = [];
    const sink = new EventSink(async (evs) => void sent.push(evs), 2);
    for (const fp of ["a", "b", "c"]) sink.node({ fingerprint: fp, kind: "page", label: fp });
    await sink.flush();
    expect(sent.map((b) => b.length)).toEqual([2, 1]);
    expect(sent.flat().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps events buffered if sending fails, so a retry resends the same seqs", async () => {
    let fail = true;
    const sent: RunnerEvent[][] = [];
    const sink = new EventSink(async (evs) => {
      if (fail) throw new Error("network");
      sent.push(evs);
    }, 100);
    sink.node({ fingerprint: "a", kind: "page", label: "/" });
    await expect(sink.flush()).rejects.toThrow("network");
    fail = false;
    await sink.flush();
    expect(sent[0]?.map((e) => e.seq)).toEqual([1]);
  });

  it("does not send empty batches", async () => {
    let calls = 0;
    const sink = new EventSink(async () => void calls++, 10);
    await sink.flush();
    expect(calls).toBe(0);
  });

  describe("auto flush", () => {
    afterEach(() => vi.useRealTimers());

    it("sends events while the job is still running, so the graph fills in live", async () => {
      vi.useFakeTimers();
      const sent: RunnerEvent[][] = [];
      const sink = new EventSink(async (evs) => void sent.push(evs), 100);
      const stop = sink.startAutoFlush(500);
      sink.node({ fingerprint: "a", kind: "page", label: "/" });
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(sent.flat().map((e) => e.seq)).toEqual([1]);
      sink.node({ fingerprint: "b", kind: "page", label: "/b" });
      await vi.advanceTimersByTimeAsync(500);
      expect(sent.flat().map((e) => e.seq)).toEqual([1, 2]);
      stop();
      sink.node({ fingerprint: "c", kind: "page", label: "/c" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(sent.flat()).toHaveLength(2); // stopped: only an explicit flush sends the rest
    });

    it("never sends two batches at once and keeps the order", async () => {
      vi.useFakeTimers();
      let inFlight = 0;
      let maxInFlight = 0;
      const order: number[] = [];
      const sink = new EventSink(async (evs) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1500)); // slower than the flush interval
        order.push(...evs.map((e) => e.seq));
        inFlight--;
      }, 1);
      const stop = sink.startAutoFlush(500);
      for (const fp of ["a", "b", "c"]) sink.node({ fingerprint: fp, kind: "page", label: fp });
      await vi.advanceTimersByTimeAsync(10_000);
      stop();
      await sink.flush();
      expect(maxInFlight).toBe(1);
      expect(order).toEqual([1, 2, 3]);
    });

    it("survives a failed send and retries on the next tick", async () => {
      vi.useFakeTimers();
      let fail = true;
      const sent: number[] = [];
      const sink = new EventSink(async (evs) => {
        if (fail) throw new Error("network");
        sent.push(...evs.map((e) => e.seq));
      }, 100);
      const stop = sink.startAutoFlush(500);
      sink.node({ fingerprint: "a", kind: "page", label: "/" });
      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toEqual([]);
      fail = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toEqual([1]);
      stop();
    });
  });
});
