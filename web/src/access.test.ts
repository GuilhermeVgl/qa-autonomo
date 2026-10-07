import { describe, expect, it } from "vitest";
import type { GraphData, GraphNode } from "./api";
import { buildAccess, graphOfUser, worstResult } from "./access";

const node = (id: string, label: string, role: string, kind = "page"): GraphNode => ({ id, kind, label, app_roles: [role], metadata: {} });

const NODES = [
  node("a1", "/", "admin"),
  node("o1", "/", "operador"),
  node("a2", "/admin", "admin"),
  node("a3", "/orders", "admin"),
  node("o3", "/orders", "operador"),
  node("o4", "/orders", "operador"), // same route, other structure (e.g. empty list)
  node("e1", "POST /orders", "", "endpoint"),
];

describe("buildAccess", () => {
  it("lists the users and which of them reach each screen, alternative flows first", () => {
    const a = buildAccess(NODES);
    expect(a.users).toEqual(["admin", "operador"]);
    expect(a.rows.map((r) => r.route)).toEqual(["/admin", "/", "/orders"]);
    const admin = a.rows[0];
    expect(admin).toMatchObject({ route: "/admin", reachedBy: ["admin"], partial: true });
    expect(a.rows.find((r) => r.route === "/")).toMatchObject({ reachedBy: ["admin", "operador"], partial: false });
    expect(a.partialCount).toBe(1);
  });

  it("keeps every node a user has for the same route in the same cell", () => {
    const orders = buildAccess(NODES).rows.find((r) => r.route === "/orders");
    expect(orders?.cells["operador"]?.map((n) => n.id)).toEqual(["o3", "o4"]);
  });

  it("leaves out endpoints and commands (they belong to no user) and never flags a single user as partial", () => {
    expect(buildAccess(NODES).rows.some((r) => r.route === "POST /orders")).toBe(false);
    const solo = buildAccess([node("a1", "/", "admin"), node("a2", "/x", "admin")]);
    expect(solo.partialCount).toBe(0);
    expect(buildAccess([]).rows).toEqual([]);
  });
});

describe("worstResult", () => {
  it("is the worst of the verdicts, and nothing when none was tested", () => {
    const [a, b] = [node("a", "/", "admin"), node("b", "/", "admin")] as [GraphNode, GraphNode];
    expect(worstResult([a, b], { a: "pass", b: "fail" })).toBe("fail");
    expect(worstResult([a, b], { a: "skipped", b: "pass" })).toBe("pass");
    expect(worstResult([a, b], { a: "skipped" })).toBe("skipped");
    expect(worstResult([a, b], {})).toBeUndefined();
    expect(worstResult([a], undefined)).toBeUndefined();
  });
});

describe("graphOfUser", () => {
  const graph: GraphData = {
    graph: { id: "g", version: 1 },
    nodes: NODES,
    edges: [
      { id: "e1", from_node_id: "a1", to_node_id: "a2", app_roles: ["admin"] },
      { id: "e2", from_node_id: "o1", to_node_id: "o3", app_roles: ["operador"] },
      { id: "e3", from_node_id: "a1", to_node_id: "o3", app_roles: [] }, // crosses users: dropped with them
    ],
  } as unknown as GraphData;

  it("keeps the screens of one user and the links among them", () => {
    const g = graphOfUser(graph, "operador");
    expect(g.nodes.map((n) => n.id)).toEqual(["o1", "o3", "o4"]);
    expect(g.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("returns the whole map when no user is chosen", () => {
    expect(graphOfUser(graph, "")).toBe(graph);
  });
});
