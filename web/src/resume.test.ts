import { describe, expect, it } from "vitest";
import type { Run } from "./api";
import { resumableExploration, stoppedBecause } from "./resume";

const run = (over: Partial<Run>): Run => ({ id: "r", type: "exploration", status: "succeeded", summary: {}, ...over });

describe("resumableExploration", () => {
  it("is the latest exploration when it stopped before the end", () => {
    for (const r of [run({ status: "cancelled" }), run({ status: "failed" }), run({ summary: { stopped_by: "max_pages" } }), run({ summary: { stopped_by: "max_seconds" } }), run({ summary: { stopped_by: "cancelled" } })]) {
      expect(resumableExploration([r])).toBe(r);
    }
  });

  it("is nothing when the latest exploration finished, is still going, or there is none", () => {
    expect(resumableExploration([run({ summary: { stopped_by: "exhausted" } })])).toBeUndefined();
    expect(resumableExploration([run({ status: "running" })])).toBeUndefined();
    expect(resumableExploration([run({ status: "queued" })])).toBeUndefined();
    expect(resumableExploration([])).toBeUndefined();
    expect(resumableExploration(undefined)).toBeUndefined();
  });

  it("is nothing for an exploration that was blocked (the application down, the login not working): there is nothing of it to continue", () => {
    expect(resumableExploration([run({ status: "failed", summary: { blocked: { kind: "login_failed", message: "x" } } })])).toBeUndefined();
  });

  it("judges only the latest exploration, whatever ran after it, and ignores regressions", () => {
    const regression = run({ type: "regression", status: "failed" });
    const finished = run({ id: "new", summary: { stopped_by: "exhausted" } });
    const interrupted = run({ id: "old", status: "cancelled" });
    expect(resumableExploration([regression, finished, interrupted])).toBeUndefined(); // the newer exploration finished
    expect(resumableExploration([regression, interrupted])?.id).toBe("old");
  });
});

describe("stoppedBecause", () => {
  it("says why in words", () => {
    expect(stoppedBecause(run({ status: "cancelled" }))).toBe("foi cancelada");
    expect(stoppedBecause(run({ status: "failed" }))).toBe("falhou");
    expect(stoppedBecause(run({ summary: { stopped_by: "max_pages" } }))).toBe("atingiu o limite de telas");
    expect(stoppedBecause(run({ summary: { stopped_by: "max_seconds" } }))).toBe("atingiu o limite de tempo");
  });
});
