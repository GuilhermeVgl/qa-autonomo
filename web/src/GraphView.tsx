import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphNode } from "./api";
import { layoutGraph, spanningTree, type Positions } from "./layout";

import { roleColor } from "./roles";
import { toneOf, type NodeCoverage, type NodeResult, type Tone } from "./tone";

export type { NodeCoverage, NodeResult };

function statusOf(n: GraphNode): number {
  const s = n.metadata["status"];
  return typeof s === "number" ? s : 200;
}

interface OrbInfo {
  label: string;
  sub: string;
  tone: Tone;
  size: number;
  role: string;
  /** The start of the map and its first level: their names stay visible even when zoomed far out. */
  hub: boolean;
}

interface Focus {
  info: Record<string, OrbInfo>;
  /** The hovered node and its neighbors; everything else fades out, as in Obsidian. */
  related: Set<string> | null;
  hovered: string | undefined;
  selected: string | undefined;
  /** Screens found a moment ago. */
  fresh: Set<string>;
}

const FocusContext = createContext<Focus>({ info: {}, related: null, hovered: undefined, selected: undefined, fresh: new Set() });

/** 0: too far out for names, 1: only the main screens are named, 2: everything is named. */
const labelLevel = (zoom: number) => (zoom >= 0.5 ? 2 : zoom >= 0.3 ? 1 : 0);

function OrbNode({ id }: NodeProps) {
  const { info, related, hovered, selected, fresh } = useContext(FocusContext);
  const level = useStore((s) => labelLevel(s.transform[2]));
  const orb = info[id];
  if (!orb) return null;
  const focused = hovered === id || selected === id || (related?.has(id) ?? false);
  const named = level === 2 || (level === 1 && orb.hub) || focused;
  const classes = ["orb", `tone-${orb.tone}`];
  if (related && !related.has(id)) classes.push("is-dim");
  if (hovered === id) classes.push("is-hovered");
  if (selected === id) classes.push("is-selected");
  if (fresh.has(id)) classes.push("is-new");
  return (
    <div className={classes.join(" ")} style={{ width: orb.size, height: orb.size, "--role": roleColor(orb.role) } as React.CSSProperties}>
      <Handle type="target" position={Position.Top} className="orb-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="orb-handle" isConnectable={false} />
      {named && (
        <span className="orb-label">
          {orb.label}
          {orb.sub && (hovered === id || selected === id) && <small>{orb.sub}</small>}
        </span>
      )}
    </div>
  );
}

const nodeTypes = { orb: OrbNode };

const LEGEND: { tone: Tone; text: string }[] = [
  { tone: "passed", text: "Passou" },
  { tone: "failing", text: "Falhou" },
  { tone: "skipped", text: "Pulado" },
  { tone: "covered", text: "Coberto, não testado" },
  { tone: "pending", text: "Pendência" },
  { tone: "no_spec", text: "Sem spec" },
];

export interface GraphViewProps {
  graph: GraphData;
  coverage?: Record<string, NodeCoverage>;
  /** The verdict of the newest test of each screen: colors the orb after a regression. */
  results?: Record<string, NodeResult>;
  selectedId?: string;
  /** The floating panels cover the right side of the canvas: keep the graph clear of them. */
  reserveRight?: boolean;
  /** An exploration is running: the camera follows the map as it grows. */
  live?: boolean;
  /** Screens found a moment ago, highlighted on the map. */
  freshIds?: Set<string>;
  onSelect: (n: GraphNode) => void;
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}

const NO_FRESH = new Set<string>();

/** Orb size by how many screens it leads to (cross links from a nav bar would make every node look important). */
const orbSize = (children: number, isRoot: boolean) => 26 + Math.min(children, 8) * 3.5 + (isRoot ? 10 : 0);

function Graph({ graph, coverage, results, selectedId, reserveRight = false, live = false, freshIds = NO_FRESH, onSelect }: GraphViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [hovered, setHovered] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [tidyKey, setTidyKey] = useState(0);
  const { fitView } = useReactFlow();
  // last known positions, including the ones the user dragged: a growing graph keeps them
  const positions = useRef<Positions>({});
  const tidyPending = useRef(false);
  const following = useRef(true);

  const tree = useMemo(() => spanningTree(graph.nodes, graph.edges), [graph.nodes, graph.edges]);

  const neighbors = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      out.set(e.from_node_id, (out.get(e.from_node_id) ?? new Set()).add(e.to_node_id));
      out.set(e.to_node_id, (out.get(e.to_node_id) ?? new Set()).add(e.from_node_id));
    }
    return out;
  }, [graph.edges]);

  const tidy = () => {
    tidyPending.current = true;
    following.current = true;
    setTidyKey((k) => k + 1);
  };

  // when an exploration ends, lay the whole map out again: while it grew, nodes only found their place one by one
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) tidy();
    if (live) following.current = true;
    wasLive.current = live;
  }, [live]);

  useEffect(() => {
    if (tidyPending.current) {
      positions.current = {};
      tidyPending.current = false;
    }
    positions.current = layoutGraph(graph.nodes, graph.edges, positions.current);
    setNodes(
      graph.nodes.map((n) => {
        const size = orbSize(tree.children[n.id]?.length ?? 0, tree.parent[n.id] === null);
        // explicit dimensions let fitView work before the nodes are measured
        return { id: n.id, type: "orb", position: positions.current[n.id] ?? { x: 0, y: 0 }, width: size, height: size, data: {} };
      }),
    );
  }, [graph.nodes, graph.edges, tree, tidyKey, setNodes]);

  const nodeCount = nodes.length;
  const hasNodes = nodeCount > 0;
  const fitKey = live ? nodeCount : 0; // while live, every new screen re-frames the map
  useEffect(() => {
    if (!hasNodes || (live && !following.current)) return;
    const timer = setTimeout(() => {
      void fitView({ padding: { top: "70px", left: "40px", bottom: "40px", right: reserveRight ? "440px" : "40px" }, maxZoom: 1.2, duration: 500 });
    }, 80);
    return () => clearTimeout(timer);
  }, [hasNodes, fitKey, tidyKey, reserveRight, live, fitView]);

  const info = useMemo(() => {
    const out: Record<string, OrbInfo> = {};
    for (const n of graph.nodes) {
      const failing = statusOf(n) >= 400;
      const role = n.app_roles[0] ?? "";
      const depth = tree.depth[n.id] ?? 0;
      out[n.id] = {
        label: `${n.label}${failing ? ` · ${statusOf(n)}` : ""}`,
        sub: [n.kind !== "page" ? n.kind : "", role].filter(Boolean).join(" · "),
        tone: toneOf(failing, results?.[n.id], coverage?.[n.id]),
        size: orbSize(tree.children[n.id]?.length ?? 0, tree.parent[n.id] === null),
        role,
        hub: depth <= 1,
      };
    }
    return out;
  }, [graph.nodes, coverage, results, tree]);

  const focus = useMemo<Focus>(
    () => ({ info, related: hovered ? new Set([hovered, ...(neighbors.get(hovered) ?? [])]) : null, hovered, selected: selectedId, fresh: freshIds }),
    [info, hovered, neighbors, selectedId, freshIds],
  );

  // The discovery tree is always drawn; the other links (nav bars, "back") only on demand or around the hovered node
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const e of graph.edges) {
      if (e.from_node_id === e.to_node_id) continue;
      const isTree = tree.treeEdgeIds.has(e.id);
      const touches = hovered !== undefined && (e.from_node_id === hovered || e.to_node_id === hovered);
      if (!isTree && !showAll && !touches) continue;
      const state = hovered ? (touches ? "is-lit" : "is-dim") : "";
      out.push({
        id: e.id,
        source: e.from_node_id,
        target: e.to_node_id,
        type: "straight",
        className: `${isTree ? "is-tree" : "is-cross"} ${state}`.trim(),
        selectable: false,
        focusable: false,
      });
    }
    return out;
  }, [graph.edges, tree, hovered, showAll]);

  const crossLinks = graph.edges.filter((e) => e.from_node_id !== e.to_node_id && !tree.treeEdgeIds.has(e.id)).length;

  return (
    <FocusContext.Provider value={focus}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodeOrigin={[0.5, 0.5]}
        minZoom={0.15}
        maxZoom={2.5}
        nodesConnectable={false}
        elementsSelectable={false}
        onMoveStart={(event) => {
          if (event) following.current = false; // the user took the camera: stop following the exploration
        }}
        onNodeClick={(_, node) => {
          const found = graph.nodes.find((n) => n.id === node.id);
          if (found) onSelect(found);
        }}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(undefined)}
        onNodeDragStop={(_, node) => {
          positions.current = { ...positions.current, [node.id]: node.position };
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="top-left" className="legend" aria-label="Legenda do grafo">
          {LEGEND.map((l) => (
            <span key={l.tone}>
              <i className={`dot tone-${l.tone}`} />
              {l.text}
            </span>
          ))}
          <span className="legend-actions">
            <button type="button" className="btn sm" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)} disabled={crossLinks === 0}>
              Todas as ligações{crossLinks > 0 ? ` (${crossLinks})` : ""}
            </button>
            <button type="button" className="btn sm" onClick={tidy}>
              Reorganizar
            </button>
          </span>
        </Panel>
      </ReactFlow>
    </FocusContext.Provider>
  );
}
