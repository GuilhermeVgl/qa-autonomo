export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
}
export type Positions = Record<string, { x: number; y: number }>;

export interface Tree {
  parent: Record<string, string | null>;
  depth: Record<string, number>;
  /** First node of each tree: the start of the exploration, plus anything not reachable from it (e.g. another role). */
  roots: string[];
  /** Nodes in discovery order. */
  order: string[];
  children: Record<string, string[]>;
  /** The edges that discovered each node. Every other edge is a cross link (nav bars, "back to home"...). */
  treeEdgeIds: Set<string>;
}

/**
 * Breadth-first discovery tree, like the explorer's crawl: depth = clicks from the start. Real apps link every page to
 * every other through a nav bar, so drawing all edges is a hairball; the tree is what makes the map readable.
 */
export function spanningTree(nodes: LayoutNode[], edges: LayoutEdge[]): Tree {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, { to: string; id: string }[]>();
  for (const e of edges) {
    if (!ids.has(e.from_node_id) || !ids.has(e.to_node_id) || e.from_node_id === e.to_node_id) continue;
    out.set(e.from_node_id, [...(out.get(e.from_node_id) ?? []), { to: e.to_node_id, id: e.id }]);
  }
  const tree: Tree = { parent: {}, depth: {}, roots: [], order: [], children: {}, treeEdgeIds: new Set() };
  for (const start of nodes) {
    if (start.id in tree.depth) continue;
    tree.roots.push(start.id);
    tree.parent[start.id] = null;
    tree.depth[start.id] = 0;
    tree.children[start.id] = [];
    const queue = [start.id];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i] as string;
      tree.order.push(cur);
      for (const next of out.get(cur) ?? []) {
        if (next.to in tree.depth) continue;
        tree.parent[next.to] = cur;
        tree.depth[next.to] = (tree.depth[cur] ?? 0) + 1;
        tree.children[next.to] = [];
        tree.children[cur]?.push(next.to);
        tree.treeEdgeIds.add(next.id);
        queue.push(next.to);
      }
    }
  }
  return tree;
}

const RING = 150; // distance between levels
const MIN_GAP = 84; // room per node along a ring (an orb plus its label)
const MARGIN = 140; // space between two separate trees
const REPULSION = 900; // force between two nodes is REPULSION / distance
const RADIAL = 0.12; // pull of a node towards its ring
/** Cap on pair evaluations, so a spec with thousands of endpoints still lays out in well under a second. */
const PAIR_BUDGET = 3e7;

/**
 * Radial tree layout: the start node in the middle, each level on its own ring, each branch in its own slice of the
 * circle. A short relaxation then separates anything that is still too close. Deterministic.
 *
 * `previous` makes the growth of a live graph calm: nodes that already have a position stay exactly where they are
 * (also the ones the user dragged) and new nodes appear next to their parent. Without it everything is placed.
 */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], previous: Positions = {}): Positions {
  const n = nodes.length;
  if (n === 0) return {};
  const tree = spanningTree(nodes, edges);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const at = (id: string) => index.get(id) as number;

  // size of each branch (leaves), to share the circle out fairly
  const weight: Record<string, number> = {};
  for (const id of [...tree.order].reverse()) {
    weight[id] = Math.max(1, (tree.children[id] ?? []).reduce((sum, c) => sum + (weight[c] ?? 1), 0));
  }

  // per tree: ring radii (wide enough for the nodes of a level to fit side by side) and its center
  const root: Record<string, string> = {};
  for (const id of tree.order) root[id] = tree.parent[id] === null ? id : (root[tree.parent[id] as string] as string);
  const ringRadius: Record<string, number[]> = {};
  for (const r of tree.roots) {
    const counts: number[] = [];
    for (const id of tree.order) if (root[id] === r) counts[tree.depth[id] ?? 0] = (counts[tree.depth[id] ?? 0] ?? 0) + 1;
    const radii = [0];
    for (let d = 1; d < counts.length; d++) radii[d] = Math.max((radii[d - 1] ?? 0) + RING, ((counts[d] ?? 0) * MIN_GAP) / (2 * Math.PI));
    ringRadius[r] = radii;
  }
  const center: Record<string, { x: number; y: number }> = {};
  let cursor = 0;
  let prevOuter = 0;
  for (const r of tree.roots) {
    const radii = ringRadius[r] as number[];
    const outer = (radii[radii.length - 1] ?? 0) + MARGIN / 2;
    cursor += tree.roots[0] === r ? 0 : prevOuter + outer;
    center[r] = { x: cursor, y: 0 };
    prevOuter = outer;
  }

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const pinned = new Uint8Array(n);
  let warm = false;
  for (const node of nodes) {
    const p = previous[node.id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      x[at(node.id)] = p.x;
      y[at(node.id)] = p.y;
      pinned[at(node.id)] = 1;
      warm = true;
    }
  }

  // sector of the circle of every node (cold start), and the angle it is seen at from its parent
  const mid: Record<string, number> = {};
  const place = (id: string, from: number, to: number): void => {
    mid[id] = (from + to) / 2;
    const kids = tree.children[id] ?? [];
    const total = kids.reduce((sum, c) => sum + (weight[c] ?? 1), 0);
    let start = from;
    for (const k of kids) {
      const share = ((to - from) * (weight[k] ?? 1)) / total;
      place(k, start, start + share);
      start += share;
    }
  };
  for (const r of tree.roots) place(r, 0, 2 * Math.PI);

  for (const id of tree.order) {
    const i = at(id);
    if (pinned[i]) continue;
    const c = center[root[id] as string] as { x: number; y: number };
    const radius = (ringRadius[root[id] as string] as number[])[tree.depth[id] ?? 0] ?? 0;
    const parent = tree.parent[id];
    if (warm && parent && previous[parent]) {
      // next to the parent, fanned out away from the middle of its tree
      const px = x[at(parent)] as number;
      const py = y[at(parent)] as number;
      const siblings = tree.children[parent] ?? [];
      const outward = Math.hypot(px - c.x, py - c.y) > 1 ? Math.atan2(py - c.y, px - c.x) : (mid[parent] ?? 0);
      const angle = outward + (siblings.indexOf(id) - (siblings.length - 1) / 2) * 0.55;
      x[i] = px + Math.cos(angle) * RING;
      y[i] = py + Math.sin(angle) * RING;
    } else {
      x[i] = c.x + Math.cos(mid[id] ?? 0) * radius;
      y[i] = c.y + Math.sin(mid[id] ?? 0) * radius;
    }
  }

  const iterations = Math.max(20, Math.min(warm ? 60 : 120, Math.floor(PAIR_BUDGET / (n * n))));
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  for (let step = 0; step < iterations; step++) {
    fx.fill(0);
    fy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = (x[i] as number) - (x[j] as number);
        let dy = (y[i] as number) - (y[j] as number);
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // coincident nodes: separate them along a fixed, pair-dependent direction
          dx = Math.cos((i + 1) * (j + 1));
          dy = Math.sin((i + 1) * (j + 1));
          d2 = 1;
        }
        const f = REPULSION / d2;
        fx[i] = (fx[i] as number) + dx * f;
        fy[i] = (fy[i] as number) + dy * f;
        fx[j] = (fx[j] as number) - dx * f;
        fy[j] = (fy[j] as number) - dy * f;
      }
    }
    for (const id of tree.order) {
      const i = at(id);
      const r = root[id] as string;
      const c = center[r] as { x: number; y: number };
      const target = (ringRadius[r] as number[])[tree.depth[id] ?? 0] ?? 0;
      let dx = (x[i] as number) - c.x;
      let dy = (y[i] as number) - c.y;
      let d = Math.hypot(dx, dy);
      if (d < 1) {
        dx = 1;
        dy = 0;
        d = 1;
      }
      const pull = (target - d) * RADIAL;
      fx[i] = (fx[i] as number) + (dx / d) * pull;
      fy[i] = (fy[i] as number) + (dy / d) * pull;
    }
    const cooling = 1 - step / iterations;
    const maxMove = (warm ? 8 : 24) * cooling + 0.5;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const len = Math.hypot(fx[i] as number, fy[i] as number);
      if (len === 0) continue;
      const move = Math.min(len, maxMove);
      x[i] = (x[i] as number) + ((fx[i] as number) / len) * move;
      y[i] = (y[i] as number) + ((fy[i] as number) / len) * move;
    }
  }

  const out: Positions = {};
  nodes.forEach((node, i) => {
    out[node.id] = { x: Math.round((x[i] as number) * 10) / 10, y: Math.round((y[i] as number) * 10) / 10 };
  });
  return out;
}
