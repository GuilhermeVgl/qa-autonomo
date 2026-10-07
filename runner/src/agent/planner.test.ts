import { describe, expect, it } from "vitest";
import { HttpError } from "../protocol/client.js";
import { LlmPlanner, identityPlanner, type Candidate, type PageContext } from "./planner.js";

const page: PageContext = { url: "https://app.test/dashboard", route: "/dashboard", depth: 1, visited: ["/", "/dashboard"] };
const cands: Candidate[] = [
  { label: "Pedidos", route: "/orders", known: false },
  { label: "Termos de uso", route: "/terms", known: false },
  { label: "Clientes", route: "/customers", known: false },
];

type Msg = { role: string; content: string };
const planner = (replies: (string | Error)[], maxCalls = 10) => {
  const sent: Msg[][] = [];
  let i = 0;
  const p = new LlmPlanner({
    chat: async (msgs) => {
      sent.push(msgs);
      const r = replies[Math.min(i++, replies.length - 1)] as string | Error;
      if (r instanceof Error) throw r;
      return r;
    },
    maxCalls,
  });
  return { p, sent, calls: () => p.calls };
};

describe("identityPlanner", () => {
  it("keeps the natural order", async () => {
    expect(await identityPlanner.rank(page, cands)).toEqual([0, 1, 2]);
  });
});

describe("LlmPlanner", () => {
  it("asks the model and follows its order, skipping what it leaves out", async () => {
    const { p, sent } = planner(['{"order":[2,0]}']);
    expect(await p.rank(page, cands)).toEqual([2, 0]);
    const all = sent[0]?.map((m) => m.content).join("\n") ?? "";
    expect(sent[0]?.[0]?.role).toBe("system");
    expect(all).toContain("dados"); // app text is data, never instructions
    expect(all).toContain("Pedidos");
    expect(all).toContain("/customers");
    expect(all).not.toContain("https://app.test"); // routes only: no hosts or credentials leave the runner
  });

  it("only ever returns valid candidate indices, whatever the model says (injection cannot add targets)", async () => {
    const { p } = planner(['{"order":[1,1,7,-1,2,"x",0.5]}']);
    expect(await p.rank(page, cands)).toEqual([1, 2]);
  });

  it.each([["not json"], ['{"order":"all"}'], ['{"nope":[0]}'], ["[]"]])("falls back to the natural order on unusable output %s", async (reply) => {
    const { p } = planner([reply]);
    expect(await p.rank(page, cands)).toEqual([0, 1, 2]);
  });

  it("does not call the model when there is nothing to choose", async () => {
    const { p, sent } = planner(['{"order":[0]}']);
    expect(await p.rank(page, [])).toEqual([]);
    expect(await p.rank(page, [cands[0] as Candidate])).toEqual([0]);
    expect(sent).toHaveLength(0);
    expect(p.calls).toBe(0);
  });

  it("stops calling the model after max calls and keeps working with the natural order", async () => {
    const { p, sent } = planner(['{"order":[2,1,0]}'], 2);
    expect(await p.rank(page, cands)).toEqual([2, 1, 0]);
    expect(await p.rank(page, cands)).toEqual([2, 1, 0]);
    expect(await p.rank(page, cands)).toEqual([0, 1, 2]);
    expect(sent).toHaveLength(2);
    expect(p.calls).toBe(2);
  });

  it("a failing call falls back for that page only", async () => {
    const { p } = planner([new Error("boom"), '{"order":[1]}']);
    expect(await p.rank(page, cands)).toEqual([0, 1, 2]);
    expect(await p.rank(page, cands)).toEqual([1]);
  });

  it("disables itself when the control plane has no LLM (503)", async () => {
    const { p, sent } = planner([new HttpError(503, "/runner/v1/llm/chat/completions")]);
    expect(await p.rank(page, cands)).toEqual([0, 1, 2]);
    expect(await p.rank(page, cands)).toEqual([0, 1, 2]);
    expect(sent).toHaveLength(1);
  });

  it("limits what it sends: at most 40 candidates and 40 visited routes", async () => {
    const many: Candidate[] = Array.from({ length: 60 }, (_, i) => ({ label: `L${i}`, route: `/r${i}`, known: false }));
    const { p, sent } = planner(['{"order":[0]}']);
    const order = await p.rank({ ...page, visited: Array.from({ length: 100 }, (_, i) => `/v${i}`) }, many);
    const body = sent[0]?.[1]?.content ?? "";
    expect(body).toContain("L39");
    expect(body).not.toContain("L40");
    expect(body).not.toContain("/v40");
    // candidates beyond the window are not offered to the model, but the natural order still covers them on fallback
    expect(order).toEqual([0]);
  });
});
