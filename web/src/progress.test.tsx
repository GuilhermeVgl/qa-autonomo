import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "./api";
import { RunProgress, formatClock, useDiscoveries } from "./progress";

const NOW = new Date("2026-10-01T12:00:00Z").getTime();
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
afterEach(() => vi.useRealTimers());

const node = (id: string) => ({ id, label: `/${id}` });

describe("formatClock", () => {
  it("shows minutes and seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(600)).toBe("10:00");
    expect(formatClock(-3)).toBe("0:00");
  });
});

describe("useDiscoveries", () => {
  it("lists screens that appear after the first look at a graph, newest first, and marks them as fresh", () => {
    const { result, rerender } = renderHook(({ graphId, nodes }) => useDiscoveries(graphId, nodes), {
      initialProps: { graphId: "g1", nodes: [node("a"), node("b")] },
    });
    expect(result.current.items).toEqual([]); // what was already there is not news
    rerender({ graphId: "g1", nodes: [node("a"), node("b"), node("c")] });
    rerender({ graphId: "g1", nodes: [node("a"), node("b"), node("c"), node("d")] });
    expect(result.current.items.map((i) => i.label)).toEqual(["/d", "/c"]);
    expect([...result.current.freshIds].sort()).toEqual(["c", "d"]);
  });

  it("stops calling a screen fresh after a few seconds", () => {
    const { result, rerender } = renderHook(({ nodes }) => useDiscoveries("g1", nodes), { initialProps: { nodes: [node("a")] } });
    rerender({ nodes: [node("a"), node("b")] });
    expect(result.current.freshIds.has("b")).toBe(true);
    act(() => void vi.setSystemTime(NOW + 10_000));
    rerender({ nodes: [node("a"), node("b")] });
    expect(result.current.freshIds.has("b")).toBe(false);
  });

  it("starts over for a new graph version (a new exploration)", () => {
    const { result, rerender } = renderHook(({ graphId, nodes }) => useDiscoveries(graphId, nodes), {
      initialProps: { graphId: "g1", nodes: [node("a")] },
    });
    rerender({ graphId: "g1", nodes: [node("a"), node("b")] });
    expect(result.current.items).toHaveLength(1);
    rerender({ graphId: "g2", nodes: [] });
    expect(result.current.items).toEqual([]);
    rerender({ graphId: "g2", nodes: [node("x")] });
    expect(result.current.items.map((i) => i.label)).toEqual(["/x"]);
  });
});

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  type: "exploration",
  status: "running",
  summary: {},
  budget: { max_pages: 50, max_depth: 4, max_seconds: 600, max_llm_calls: 30 },
  created_at: new Date(NOW - 100_000).toISOString(),
  started_at: new Date(NOW - 75_000).toISOString(),
  finished_at: null,
  ...over,
});

describe("RunProgress", () => {
  it("shows the live numbers of an exploration: screens against the budget, links and elapsed time", () => {
    const items = [{ id: "c", label: "/clients/:id", at: NOW - 3000 }];
    render(<RunProgress run={run({})} nodes={3} edges={7} items={items} />);
    expect(screen.getByText("Mapeando a aplicação")).toBeInTheDocument();
    expect(screen.getByText(/3 telas mapeadas/)).toBeInTheDocument();
    expect(screen.getByText(/de até 50/)).toBeInTheDocument();
    expect(screen.getByText(/7 ligações/)).toBeInTheDocument();
    expect(screen.getByText(/1:15/)).toBeInTheDocument();
    expect(screen.getByText(/10:00/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /telas/i })).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByRole("list", { name: /Descobertas/ })).toHaveTextContent("/clients/:id");
  });

  it("says when the run is still waiting for a runner", () => {
    render(<RunProgress run={run({ status: "queued", started_at: null })} nodes={0} edges={0} items={[]} />);
    expect(screen.getByText("Na fila")).toBeInTheDocument();
    expect(screen.getByText(/aguardando um runner/i)).toBeInTheDocument();
  });

  it("explains an empty feed while the first screen has not shown up", () => {
    render(<RunProgress run={run({})} nodes={0} edges={0} items={[]} />);
    expect(screen.getByText(/Aguardando a primeira tela/)).toBeInTheDocument();
  });

  it("does not talk about screens when the run is a regression", () => {
    render(<RunProgress run={run({ type: "regression" })} nodes={12} edges={20} items={[]} />);
    expect(screen.getByText("Executando a regressão")).toBeInTheDocument();
    expect(screen.queryByText(/telas mapeadas/)).not.toBeInTheDocument();
  });
});
