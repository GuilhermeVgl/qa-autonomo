import { describe, expect, it } from "vitest";
import type { Run } from "./api";
import { currentBlock } from "./blocked";

const run = (over: Partial<Run>): Run => ({ id: "r", type: "exploration", status: "succeeded", summary: {}, ...over });
const blockedRun = (kind: string, over: Partial<Run> = {}): Run => run({ status: "failed", summary: { blocked: { kind, message: "m" } }, ...over });

describe("currentBlock", () => {
  it("is what stopped the latest finished run, so it is shown until a run gets past it", () => {
    const b = currentBlock([blockedRun("login_failed", { id: "new" }), run({ id: "old" })]);
    expect(b?.run.id).toBe("new");
    expect(b?.blocked.kind).toBe("login_failed");
  });

  it("is nothing once a later run worked", () => {
    expect(currentBlock([run({ id: "ok" }), blockedRun("app_down", { id: "old" })])).toBeUndefined();
  });

  it("ignores runs still going or waiting, and looks at the one before them", () => {
    expect(currentBlock([run({ status: "running" }), run({ status: "queued" }), blockedRun("app_down")])?.blocked.kind).toBe("app_down");
  });

  it("takes a run that finished fine but noted a user who could not get in", () => {
    const partial = run({ summary: { blocked: { kind: "login_failed", message: "Não foi possível entrar como op", roles: ["op"] } } });
    expect(currentBlock([partial])?.blocked.roles).toEqual(["op"]);
  });

  it("is nothing without runs, or when the summary says nothing of it", () => {
    expect(currentBlock(undefined)).toBeUndefined();
    expect(currentBlock([])).toBeUndefined();
    expect(currentBlock([run({ summary: { blocked: { kind: "x" } } })])).toBeUndefined(); // no message to show
  });
});
