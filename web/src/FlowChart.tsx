import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useContext, useEffect, useMemo } from "react";
import { BOX_W, type Box, type Layout } from "./flows";
import type { PossibilityView } from "./flows";
import { roleColor } from "./roles";
import { ScreenCard, userLabel } from "./ScreenCard";
import type { Tone } from "./tone";

interface ChartContext {
  token: string;
  selectedBox: string | undefined;
  tones: Record<string, Tone>;
  focus: Record<string, string>;
  possibilities: Record<string, PossibilityView[]>;
  onSelect: (box: Box) => void;
}

const Ctx = createContext<ChartContext>({ token: "", selectedBox: undefined, tones: {}, focus: {}, possibilities: {}, onSelect: () => undefined });

function ScreenNode({ data }: NodeProps) {
  const { token, selectedBox, tones, focus, possibilities, onSelect } = useContext(Ctx);
  const box = (data as { box: Box }).box;
  return (
    <div className="flow-node" style={{ width: BOX_W, height: box.h }}>
      <Handle type="target" position={Position.Left} className="orb-handle" isConnectable={false} />
      <ScreenCard box={box} tone={tones[box.id] ?? "neutral"} token={token} selected={selectedBox === box.id} onSelect={() => onSelect(box)} focusId={focus[box.id]} possibilities={possibilities[box.id] ?? []} />
      <Handle type="source" position={Position.Right} className="orb-handle" isConnectable={false} />
    </div>
  );
}

function LaneNode({ data }: NodeProps) {
  const { user, width, height } = data as { user: string; width: number; height: number };
  return (
    <div className="flow-lane" style={{ width, height, "--role": roleColor(user) } as React.CSSProperties}>
      <span className="lane-name">
        <i style={{ background: roleColor(user) }} /> {userLabel(user)}
      </span>
    </div>
  );
}

const nodeTypes = { screen: ScreenNode, lane: LaneNode };

/**
 * The nodes of the chart: a backdrop per user and a card per screen. The cards hold buttons, so they must receive pointer
 * events: React Flow switches them off for nodes that cannot be dragged or selected, and these cannot.
 */
export function flowNodes(layout: Layout): Node[] {
  const lanes: Node[] = layout.lanes.map((l) => ({
    id: `lane:${l.user}`,
    type: "lane",
    position: { x: -24, y: l.top },
    data: { user: l.user, width: layout.width + 48, height: l.height },
    draggable: false,
    selectable: false,
    zIndex: -1,
    style: { width: layout.width + 48, height: l.height, pointerEvents: "none" },
  }));
  const boxes: Node[] = layout.boxes.map((b) => ({
    id: b.id,
    type: "screen",
    position: { x: b.x, y: b.y },
    data: { box: b },
    draggable: false,
    style: { width: BOX_W, height: b.h, pointerEvents: "all" },
  }));
  return [...lanes, ...boxes];
}

function Chart({ layout, flowId }: { layout: Layout; flowId: string }) {
  const { fitView } = useReactFlow();
  const nodes = useMemo(() => flowNodes(layout), [layout]);

  const edges = useMemo<Edge[]>(
    () =>
      layout.arrows.map((a) => ({
        id: a.id,
        source: a.from,
        target: a.to,
        label: a.label,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: roleColor(a.user) },
        style: { stroke: roleColor(a.user), strokeWidth: 2 },
        labelStyle: { fontSize: 11, fontWeight: 600 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 8,
      })),
    [layout],
  );

  useEffect(() => {
    const timer = setTimeout(() => void fitView({ padding: 0.1, minZoom: 0.45, maxZoom: 1, duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [flowId, layout, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onlyRenderVisibleElements
      minZoom={0.1}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export interface FlowChartProps {
  layout: Layout;
  flowId: string;
  tones: Record<string, Tone>;
  /** Which node stands for each box (the one that failed, when one did). */
  focus: Record<string, string>;
  possibilities: Record<string, PossibilityView[]>;
  token: string;
  selectedBox: string | undefined;
  onSelect: (box: Box) => void;
}

/** The flow as lanes of users, left to right, each screen with its picture. */
export function FlowChart({ layout, flowId, tones, focus, possibilities, token, selectedBox, onSelect }: FlowChartProps) {
  const ctx = useMemo<ChartContext>(() => ({ token, selectedBox, tones, focus, possibilities, onSelect }), [token, selectedBox, tones, focus, possibilities, onSelect]);
  return (
    <Ctx.Provider value={ctx}>
      <ReactFlowProvider>
        <Chart layout={layout} flowId={flowId} />
      </ReactFlowProvider>
    </Ctx.Provider>
  );
}
