import { describe, expect, it } from "vitest";
import { layoutGraph, spanningTree, type Positions } from "./layout";

const n = (id: string) => ({ id });
const e = (from: string, to: string) => ({ id: `${from}>${to}`, from_node_id: from, to_node_id: to });
const gap = (a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined) => Math.hypot((a?.x ?? NaN) - (b?.x ?? NaN), (a?.y ?? NaN) - (b?.y ?? NaN));
const dist = (pos: Positions, a: string, b: string) => gap(pos[a], pos[b]);
const minPairDistance = (pos: Positions) => {
  const ids = Object.keys(pos);
  let min = Infinity;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) min = Math.min(min, dist(pos, ids[i] as string, ids[j] as string));
  return min;
};

describe("spanningTree", () => {
  it("walks the graph breadth-first from the first node, so depth is the discovery distance", () => {
    const t = spanningTree([n("root"), n("a"), n("b"), n("a1")], [e("root", "a"), e("root", "b"), e("a", "a1")]);
    expect(t.depth).toEqual({ root: 0, a: 1, b: 1, a1: 2 });
    expect(t.parent).toEqual({ root: null, a: "root", b: "root", a1: "a" });
    expect([...t.treeEdgeIds].sort()).toEqual(["a>a1", "root>a", "root>b"]);
  });

  it("leaves cross links (nav bars, back links) out of the tree", () => {
    const t = spanningTree([n("root"), n("a"), n("b")], [e("root", "a"), e("root", "b"), e("a", "b"), e("b", "root"), e("a", "a")]);
    expect([...t.treeEdgeIds].sort()).toEqual(["root>a", "root>b"]);
  });

  it("starts a new tree for nodes that cannot be reached, and ignores edges to unknown nodes", () => {
    const t = spanningTree([n("a"), n("b"), n("lonely")], [e("a", "b"), e("a", "ghost")]);
    expect(t.roots).toEqual(["a", "lonely"]);
    expect(t.depth["lonely"]).toBe(0);
    expect(t.treeEdgeIds.size).toBe(1);
  });
});

describe("layoutGraph", () => {
  it("positions every node with finite coordinates, and an empty graph yields nothing", () => {
    const pos = layoutGraph([n("a"), n("b"), n("lonely")], [e("a", "b")]);
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "lonely"]);
    for (const p of Object.values(pos)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(layoutGraph([], [])).toEqual({});
  });

  it("is deterministic", () => {
    const nodes = [n("a"), n("b"), n("c"), n("d")];
    const edges = [e("a", "b"), e("a", "c"), e("c", "d")];
    expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
  });

  it("puts each level on its own ring around the root: deeper nodes are farther away", () => {
    const nodes = ["root", "a", "b", "c", "a1", "a2", "b1", "c1"].map(n);
    const edges = [e("root", "a"), e("root", "b"), e("root", "c"), e("a", "a1"), e("a", "a2"), e("b", "b1"), e("c", "c1")];
    const pos = layoutGraph(nodes, edges);
    const ring = (ids: string[]) => ids.reduce((sum, id) => sum + dist(pos, "root", id), 0) / ids.length;
    expect(ring(["a", "b", "c"])).toBeGreaterThan(60);
    expect(ring(["a1", "a2", "b1", "c1"])).toBeGreaterThan(ring(["a", "b", "c"]) + 60);
  });

  it("keeps a branch together: children sit closer to their own parent than to another branch", () => {
    const nodes = ["root", "a", "b", "a1", "a2", "b1", "b2"].map(n);
    const edges = [e("root", "a"), e("root", "b"), e("a", "a1"), e("a", "a2"), e("b", "b1"), e("b", "b2")];
    const pos = layoutGraph(nodes, edges);
    expect(dist(pos, "a1", "a")).toBeLessThan(dist(pos, "a1", "b"));
    expect(dist(pos, "b2", "b")).toBeLessThan(dist(pos, "b2", "a"));
  });

  it("is not tangled by a navigation bar: every page linking back to the others lays out like the plain tree", () => {
    const ids = ["root", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"];
    const depth = (id: string) => (id === "root" ? 0 : Number(id.slice(1)) <= 5 ? 1 : 2);
    const nodes = ids.map(n);
    const tree = ids.slice(1).map((id, i) => e(i < 5 ? "root" : `p${(i % 5) + 1}`, id));
    // links back to the same level or above (nav bar, "home", breadcrumbs): they never change the discovery tree
    const known = new Set(tree.map((t) => t.id));
    const navLinks = ids.flatMap((a) => ids.filter((b) => b !== a && depth(b) <= depth(a)).map((b) => e(a, b))).filter((x) => !known.has(x.id));
    expect(navLinks.length).toBeGreaterThan(20);
    const tangled = layoutGraph(nodes, [...tree, ...navLinks]);
    expect(tangled).toEqual(layoutGraph(nodes, tree));
    expect(minPairDistance(tangled)).toBeGreaterThan(60);
  });

  it("never stacks two nodes, even for a hub with many children", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => n(`n${i}`));
    const pos = layoutGraph(nodes, nodes.slice(1).map((node) => e("n0", node.id)));
    expect(minPairDistance(pos)).toBeGreaterThan(60);
  });

  it("keeps separate trees (one per role) apart", () => {
    const nodes = ["a", "a1", "a2", "a3", "b", "b1", "b2", "b3"].map(n);
    const edges = [e("a", "a1"), e("a", "a2"), e("a", "a3"), e("b", "b1"), e("b", "b2"), e("b", "b3")];
    const pos = layoutGraph(nodes, edges);
    const radius = (root: string, kids: string[]) => Math.max(...kids.map((k) => dist(pos, root, k)));
    expect(dist(pos, "a", "b")).toBeGreaterThan(radius("a", ["a1", "a2", "a3"]) + radius("b", ["b1", "b2", "b3"]));
  });

  it("handles cycles, self references and edges to unknown nodes", () => {
    const pos = layoutGraph([n("a"), n("b")], [e("a", "b"), e("b", "a"), e("a", "a"), e("a", "ghost")]);
    expect(Object.keys(pos).sort()).toEqual(["a", "b"]);
  });

  it("keeps nodes already placed where they were when the graph grows, and puts the newcomer by its parent", () => {
    const nodes = ["root", "a", "b", "c"].map(n);
    const edges = [e("root", "a"), e("root", "b"), e("root", "c")];
    const before = layoutGraph(nodes, edges);
    const after = layoutGraph([...nodes, n("a1")], [...edges, e("a", "a1")], before);
    for (const id of ["root", "a", "b", "c"]) expect(gap(before[id], after[id])).toBeLessThan(60);
    expect(dist(after, "a", "a1")).toBeLessThan(dist(after, "b", "a1"));
  });

  it("scales to a few thousand nodes", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => n(`n${i}`));
    const edges = nodes.slice(1).map((node, i) => e(`n${Math.floor(i / 3)}`, node.id));
    expect(Object.keys(layoutGraph(nodes, edges))).toHaveLength(2000);
  });
});
