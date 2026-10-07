import type { GraphData, GraphNode } from "./api";
import type { NodeResult } from "./tone";

/** One screen and which users reach it. A user can have more than one node for the same route (different structure). */
export interface AccessRow {
  route: string;
  kind: string;
  cells: Record<string, GraphNode[]>;
  reachedBy: string[];
  /** Not every user reaches it: an alternative flow worth testing on its own. */
  partial: boolean;
}

export interface Access {
  users: string[];
  rows: AccessRow[];
  /** Screens only some users reach. */
  partialCount: number;
}

/** Who sees what: the screens of the map against the users that reached them. Endpoints and commands belong to no user. */
export function buildAccess(nodes: GraphNode[]): Access {
  const screens = nodes.filter((n) => (n.kind === "page" || n.kind === "modal") && n.app_roles.length > 0);
  const users = [...new Set(screens.flatMap((n) => n.app_roles))].sort();
  const byRoute = new Map<string, AccessRow>();
  for (const n of screens) {
    const key = `${n.kind}|${n.label}`;
    let row = byRoute.get(key);
    if (!row) {
      row = { route: n.label, kind: n.kind, cells: {}, reachedBy: [], partial: false };
      byRoute.set(key, row);
    }
    for (const user of n.app_roles) (row.cells[user] ??= []).push(n);
  }
  const rows = [...byRoute.values()].map((row) => {
    const reachedBy = users.filter((u) => row.cells[u]);
    return { ...row, reachedBy, partial: users.length > 1 && reachedBy.length < users.length };
  });
  // alternative flows first, then by route
  rows.sort((a, b) => Number(b.partial) - Number(a.partial) || a.route.localeCompare(b.route));
  return { users, rows, partialCount: rows.filter((r) => r.partial).length };
}

const SEVERITY: Record<NodeResult, number> = { error: 3, fail: 3, pass: 1, skipped: 0 };

/** The worst verdict among the nodes of a cell; undefined when none was tested. */
export function worstResult(nodes: GraphNode[], results: Record<string, NodeResult> | undefined): NodeResult | undefined {
  let worst: NodeResult | undefined;
  for (const n of nodes) {
    const r = results?.[n.id];
    if (r && (worst === undefined || SEVERITY[r] > SEVERITY[worst])) worst = r;
  }
  return worst;
}

/** The map as one user sees it. */
export function graphOfUser(graph: GraphData, user: string): GraphData {
  if (user === "") return graph;
  const nodes = graph.nodes.filter((n) => n.app_roles.includes(user));
  const keep = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => keep.has(e.from_node_id) && keep.has(e.to_node_id)) };
}
