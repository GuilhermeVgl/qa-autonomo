import { describe, expect, it } from "vitest";
import type { GraphData, GraphEdge, GraphNode } from "./api";
import { flowNodes } from "./FlowChart";
import { buildModel, detectJourneys, layoutFlow } from "./flows";

const node = (id: string, kind: string, label: string, roles: string[]): GraphNode => ({ id, kind, label, app_roles: roles, metadata: {} });
const edge = (id: string, from: string, to: string, role: string, action: Record<string, unknown>): GraphEdge => ({ id, from_node_id: from, to_node_id: to, key: id, action, app_roles: [role] });

const graph = {
  graph: { id: "g", version: 1 },
  nodes: [node("a", "page", "/clients", ["admin"]), node("m", "modal", "/clients › Novo", ["admin"]), node("o", "page", "/clients", ["operador"])],
  edges: [edge("e", "a", "m", "admin", { type: "click", label: "Novo", intent: "open" })],
} as unknown as GraphData;

describe("flowNodes", () => {
  const model = buildModel(graph);
  const flow = detectJourneys(model)[0];
  const nodes = flow ? flowNodes(layoutFlow(model, flow)) : [];

  it("lets the cards receive clicks (React Flow turns pointer events off for nodes that cannot be dragged or selected)", () => {
    const cards = nodes.filter((n) => n.type === "screen");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.style?.pointerEvents).toBe("all");
  });

  it("keeps the lane backdrops out of the way of the cards", () => {
    const lanes = nodes.filter((n) => n.type === "lane");
    expect(lanes.map((l) => l.id)).toEqual(["lane:admin", "lane:operador"]);
    for (const l of lanes) {
      expect(l.style?.pointerEvents).toBe("none");
      expect(l.zIndex).toBe(-1);
    }
  });

  it("gives each card the size its kind needs", () => {
    const modal = nodes.find((n) => n.id.startsWith("modal|"));
    const page = nodes.find((n) => n.id.startsWith("page|"));
    expect(Number(modal?.style?.height)).toBeGreaterThan(0);
    expect(page?.style?.height).toBe(modal?.style?.height);
  });
});
