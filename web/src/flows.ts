import type { GraphData, GraphEdge, GraphNode, RunStep } from "./api";
import { worstResult } from "./access";
import { toneOf, type NodeCoverage, type NodeResult, type Tone } from "./tone";

/** A screen of the map seen across users: the same route reached by admin and by operador is one screen with two cells. */
export interface Screen {
  key: string;
  kind: string;
  route: string;
  /** The nodes each user has for it. A user can have more than one (the same route with another structure). */
  cells: Record<string, GraphNode[]>;
  /** The requirements that cover the screen, whichever user's node they were linked to. Empty: nothing specifies it. */
  requirements: string[];
}

export type TransitionKind = "link" | "open" | "click" | "submit" | "search" | "request";

/** Something the agent did to get from one screen to another, at the level of screens (not of one user's nodes). */
export interface Transition {
  id: string;
  from: string;
  to: string;
  kind: TransitionKind;
  label: string;
  /** Users whose exploration found it. */
  users: string[];
}

export interface Model {
  screens: Map<string, Screen>;
  transitions: Transition[];
  out: Map<string, Transition[]>;
  /** node id -> screen key */
  screenOf: Map<string, string>;
}

export type FlowOrigin = "journey" | "requirement" | "run";

export interface Flow {
  id: string;
  origin: FlowOrigin;
  title: string;
  subtitle: string;
  /** Where the flow begins: the first column. */
  start: string[];
  screens: string[];
  transitions: Transition[];
  /** For a run: what each node got in it. Absent means the latest verdicts of the map apply. */
  results?: Record<string, NodeResult>;
  /** The user names that reach at least one screen of the flow. */
  users: string[];
  /** Screens that not every user of the flow reaches. */
  partial: number;
  /** Pages of the flow that no requirement covers: the flow does what the specification does not say. */
  uncovered: string[];
}

export const NO_USER = "";
const INTERACTIVE: TransitionKind[] = ["open", "click", "submit", "search", "request"];

const screenKey = (n: GraphNode): string => `${n.kind}|${n.label}`;
const usersOf = (n: GraphNode): string[] => (n.app_roles.length > 0 ? n.app_roles : [NO_USER]);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function describe(edge: GraphEdge, target: GraphNode): { kind: TransitionKind; label: string } {
  const a = edge.action ?? {};
  const label = str(a["label"]).trim();
  switch (str(a["type"])) {
    case "request": {
      const trigger = str(a["trigger"]).trim();
      const call = `${str(a["method"])} ${str(a["path"])}`.trim() + (a["blocked"] === true ? " (bloqueada)" : "");
      return { kind: "request", label: trigger ? `${trigger} → ${call}` : call };
    }
    case "submit":
      return { kind: "submit", label: label ? `envia “${label}”` : "envia o formulário" };
    case "search":
      return { kind: "search", label: label ? `busca “${label}”` : "busca" };
    case "click":
      return target.kind === "modal" ? { kind: "open", label: label ? `abre “${label}”` : "abre uma janela" } : { kind: "click", label: label ? `clica em “${label}”` : "clica" };
    default:
      return { kind: "link", label: label ? `vai para “${label}”` : "vai para a tela" };
  }
}

/** The map at the level of screens: nodes of every user that share a route become one screen, edges become transitions. */
export function buildModel(graph: GraphData): Model {
  const screens = new Map<string, Screen>();
  const screenOf = new Map<string, string>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (n.kind !== "page" && n.kind !== "modal" && n.kind !== "endpoint") continue;
    const key = screenKey(n);
    const screen = screens.get(key) ?? { key, kind: n.kind, route: n.label, cells: {}, requirements: [] };
    for (const u of usersOf(n)) (screen.cells[u] ??= []).push(n);
    for (const k of n.requirement_keys ?? []) if (!screen.requirements.includes(k)) screen.requirements = [...screen.requirements, k].sort();
    screens.set(key, screen);
    screenOf.set(n.id, key);
  }
  const merged = new Map<string, Transition>();
  for (const e of graph.edges) {
    const from = screenOf.get(e.from_node_id);
    const to = screenOf.get(e.to_node_id);
    const target = nodeById.get(e.to_node_id);
    if (!from || !to || from === to || !target) continue;
    const { kind, label } = describe(e, target);
    const id = `${from}>${to}|${kind}|${label}`;
    const users = e.app_roles && e.app_roles.length > 0 ? e.app_roles : [NO_USER];
    const known = merged.get(id);
    if (known) known.users = [...new Set([...known.users, ...users])].sort();
    else merged.set(id, { id, from, to, kind, label, users: [...users].sort() });
  }
  const transitions = [...merged.values()];
  const out = new Map<string, Transition[]>();
  for (const t of transitions) out.set(t.from, [...(out.get(t.from) ?? []), t]);
  return { screens, transitions, out, screenOf };
}

function usersAcross(model: Model, keys: string[]): { users: string[]; partial: number } {
  const users = new Set<string>();
  for (const k of keys) for (const u of Object.keys(model.screens.get(k)?.cells ?? {})) users.add(u);
  const all = [...users].sort();
  const partial = keys.filter((k) => Object.keys(model.screens.get(k)?.cells ?? {}).length < all.length).length;
  return { users: all, partial: all.length > 1 ? partial : 0 };
}

function makeFlow(model: Model, origin: FlowOrigin, id: string, title: string, subtitle: string, start: string[], screens: string[], transitions: Transition[], results?: Record<string, NodeResult>): Flow {
  const { users, partial } = usersAcross(model, screens);
  const uncovered = screens.filter((k) => {
    const s = model.screens.get(k);
    return s?.kind === "page" && s.requirements.length === 0 && !Object.values(s.cells).flat().some((n) => (n.requirement_count ?? 0) > 0);
  });
  return { id, origin, title, subtitle, start, screens, transitions, users, partial, uncovered, ...(results ? { results } : {}) };
}

/** What can be reached from a screen by doing things (opening, sending, searching, calling), a few steps deep. */
function expand(model: Model, starts: string[], maxDepth: number): { screens: string[]; transitions: Transition[] } {
  const seen = new Map<string, number>(starts.map((s) => [s, 0]));
  const order = [...starts];
  const used = new Map<string, Transition>();
  const queue = [...starts];
  while (queue.length > 0) {
    const from = queue.shift() as string;
    const depth = seen.get(from) ?? 0;
    if (depth >= maxDepth) continue;
    for (const t of model.out.get(from) ?? []) {
      if (!INTERACTIVE.includes(t.kind)) continue;
      used.set(t.id, t);
      if (!seen.has(t.to)) {
        seen.set(t.to, depth + 1);
        order.push(t.to);
        // a page reached by sending a form or searching ends the story there; a window or a call can lead further
        if (model.screens.get(t.to)?.kind !== "page" || t.kind === "click") queue.push(t.to);
      }
    }
  }
  return { screens: order, transitions: [...used.values()] };
}

const MAX_JOURNEYS = 200;

/**
 * The stories the map already tells: a screen where the agent could open a window, send a form, search or call an
 * endpoint, with where each of those led. Plain navigation links are left out: they connect everything to everything.
 */
export function detectJourneys(model: Model, maxDepth = 4): Flow[] {
  const flows: Flow[] = [];
  for (const screen of model.screens.values()) {
    if (screen.kind !== "page") continue;
    const first = (model.out.get(screen.key) ?? []).filter((t) => INTERACTIVE.includes(t.kind));
    if (first.length === 0) continue;
    const { screens, transitions } = expand(model, [screen.key], maxDepth);
    const actions = [...new Set(first.map((t) => t.label))].slice(0, 3).join(" · ");
    flows.push(makeFlow(model, "journey", `journey:${screen.key}`, screen.route, actions, [screen.key], screens, transitions));
  }
  flows.sort((a, b) => b.partial - a.partial || b.screens.length - a.screens.length || a.title.localeCompare(b.title));
  return flows.slice(0, MAX_JOURNEYS);
}

/** One flow per requirement: the screens it is linked to and what can be done from them. */
export function requirementFlows(model: Model, requirements: { key: string; text: string; node_ids: string[] }[]): Flow[] {
  const flows: Flow[] = [];
  for (const r of requirements) {
    const starts = [...new Set(r.node_ids.map((id) => model.screenOf.get(id)).filter((k): k is string => k !== undefined))];
    if (starts.length === 0) continue;
    const { screens, transitions } = expand(model, starts, 3);
    flows.push(makeFlow(model, "requirement", `req:${r.key}`, r.key, r.text.length > 110 ? `${r.text.slice(0, 107)}…` : r.text, starts, screens, transitions));
  }
  return flows.slice(0, 400);
}

const SEVERITY: Record<NodeResult, number> = { error: 3, fail: 3, pass: 1, skipped: 0 };

/** What a run tested, as a flow: the screens it checked, the ways between them, and what each check said. */
export function runFlow(model: Model, steps: Pick<RunStep, "node_id" | "result">[], title: string, subtitle: string): Flow | null {
  const results: Record<string, NodeResult> = {};
  for (const s of steps) {
    if (!s.node_id || !s.result) continue;
    const r = s.result as NodeResult;
    const known = results[s.node_id];
    if (known === undefined || SEVERITY[r] > SEVERITY[known]) results[s.node_id] = r;
  }
  const keys = [...new Set(Object.keys(results).map((id) => model.screenOf.get(id)).filter((k): k is string => k !== undefined))];
  if (keys.length === 0) return null;
  const set = new Set(keys);
  const transitions = model.transitions.filter((t) => set.has(t.from) && set.has(t.to));
  // the entry points: screens nothing else in the run leads to (or all of them when everything leads somewhere)
  const reached = new Set(transitions.map((t) => t.to));
  let start = keys.filter((k) => !reached.has(k));
  if (start.length === 0) start = [keys[0] as string];
  return makeFlow(model, "run", "run", title, subtitle, start, keys, transitions, results);
}

// ---- permissions: what a user sees on a screen that another does not ----

/** Controls and forms of a node, by what the exploration read from the page. */
function capabilities(n: GraphNode): string[] {
  const m = n.metadata as { controls?: { label?: string }[]; forms?: { method?: string; action?: string; label?: string }[] };
  const controls = (m.controls ?? []).map((c) => str(c.label).trim()).filter(Boolean);
  const forms = (m.forms ?? []).map((f) => str(f.label).trim() || `${str(f.method)} ${str(f.action)}`.trim()).filter(Boolean);
  return [...controls, ...forms.map((f) => `formulário ${f}`)];
}

/**
 * Per user, what only they have on a screen several users reach. It answers "same screen, different permission":
 * the admin's list has "Excluir" and "Aprovar" where the operator's does not.
 */
export function screenDifferences(screen: Screen): Record<string, string[]> {
  const users = Object.keys(screen.cells);
  if (users.length < 2) return {};
  const caps = new Map(users.map((u) => [u, new Set((screen.cells[u] ?? []).flatMap(capabilities))]));
  const out: Record<string, string[]> = {};
  for (const u of users) {
    const others = new Set(users.filter((x) => x !== u).flatMap((x) => [...(caps.get(x) ?? [])]));
    const only = [...(caps.get(u) ?? [])].filter((c) => !others.has(c));
    if (only.length > 0) out[u] = only;
  }
  return out;
}

// ---- layout: columns are steps of the flow, rows are lanes of users ----

export const BOX_W = 232;
export const BOX_H = 176;
/** An API call is a line of text, not a screen: it does not need the height of a picture. */
export const ENDPOINT_H = 72;
/** A column holds at most this many screens; more wrap into the next column so a flow stays wide, not a tall strip. */
export const MAX_ROWS = 4;
const COL_GAP = 120;
const ROW_GAP = 28;
const LANE_HEAD = 44;
const LANE_PAD = 14;

export interface Box {
  id: string;
  screen: Screen;
  user: string;
  /** The user's nodes for the screen; empty for a ghost (this user does not reach it). */
  nodes: GraphNode[];
  ghost: boolean;
  x: number;
  y: number;
  /** Height: a screen has room for its picture, an API call does not. */
  h: number;
  /** Only for real boxes: what this user has on the screen that the others do not. */
  only: string[];
}

/**
 * What an arrow says. A call's endpoint is already on its own card, so the arrow keeps only what triggered it
 * ("Salvar"); the rest of the arrows say it all.
 */
export function arrowText(t: Pick<Transition, "kind" | "label">): string {
  if (t.kind !== "request") return t.label;
  const [trigger] = t.label.split(" → ");
  return t.label.includes(" → ") && trigger ? trigger : "chama a API";
}

export interface Arrow {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: TransitionKind;
  user: string;
}

export interface Lane {
  user: string;
  top: number;
  height: number;
}

export interface Layout {
  lanes: Lane[];
  boxes: Box[];
  arrows: Arrow[];
  width: number;
  height: number;
}

const heightOf = (screen: Screen | undefined): number => (screen?.kind === "endpoint" ? ENDPOINT_H : BOX_H);

/**
 * Assigns each screen of a flow a column (how many steps from the start). A column that holds more than MAX_ROWS screens
 * is wrapped into several, so the flow stays wide and readable instead of one tall strip.
 */
function columns(model: Model, flow: Flow): { x: Map<string, number>; y: Map<string, number>; col: Map<string, number>; columnCount: number; rowsHeight: number } {
  const set = new Set(flow.screens);
  const out = new Map<string, Transition[]>();
  for (const t of flow.transitions) if (set.has(t.from) && set.has(t.to)) out.set(t.from, [...(out.get(t.from) ?? []), t]);
  const col = new Map<string, number>();
  const queue: string[] = [];
  const begin = (s: string) => {
    col.set(s, 0);
    queue.push(s);
  };
  for (const s of flow.start.filter((s) => set.has(s))) begin(s);
  const bfs = () => {
    while (queue.length > 0) {
      const from = queue.shift() as string;
      for (const t of out.get(from) ?? []) {
        if (col.has(t.to)) continue;
        col.set(t.to, (col.get(from) ?? 0) + 1);
        queue.push(t.to);
      }
    }
  };
  bfs();
  for (const s of flow.screens) {
    if (col.has(s)) continue;
    begin(s); // not reachable from the start: its own beginning
    bfs();
  }
  const logical = Math.max(0, ...col.values()) + 1;
  const ordered = [...flow.screens].sort((a, b) => (col.get(a) ?? 0) - (col.get(b) ?? 0) || flow.screens.indexOf(a) - flow.screens.indexOf(b));
  // place the screens of each column top to bottom, starting a new sub-column after MAX_ROWS
  const x = new Map<string, number>();
  const y = new Map<string, number>();
  let columnCount = 0;
  let rowsHeight = 0;
  for (let c = 0; c < logical; c++) {
    const here = ordered.filter((s) => col.get(s) === c);
    const subs = Math.max(1, Math.ceil(here.length / MAX_ROWS));
    for (let sc = 0; sc < subs; sc++) {
      let top = 0;
      for (const s of here.slice(sc * MAX_ROWS, (sc + 1) * MAX_ROWS)) {
        x.set(s, columnCount + sc);
        y.set(s, top);
        top += heightOf(model.screens.get(s)) + ROW_GAP;
      }
      rowsHeight = Math.max(rowsHeight, top - ROW_GAP);
    }
    columnCount += subs;
  }
  return { x, y, col, columnCount, rowsHeight: Math.max(rowsHeight, 0) };
}

/**
 * Lays a flow out as lanes, one per user, with the same columns in each. A screen a user does not reach appears as a
 * ghost in their lane, so a missing permission is as visible as a present one. Arrows stay inside a lane: they show what
 * that user's own exploration did.
 */
export function layoutFlow(model: Model, flow: Flow): Layout {
  const { x, y, col, columnCount, rowsHeight } = columns(model, flow);
  const users = flow.users;
  const laneHeight = LANE_HEAD + rowsHeight + LANE_PAD;
  const lanes: Lane[] = users.map((user, i) => ({ user, top: i * (laneHeight + 16), height: laneHeight }));
  const boxes: Box[] = [];
  const idOf = (key: string, user: string) => `${key}@${user}`;
  for (const lane of lanes) {
    for (const key of flow.screens) {
      const screen = model.screens.get(key);
      if (!screen) continue;
      const nodes = screen.cells[lane.user] ?? [];
      if (nodes.length === 0 && screen.kind === "endpoint") continue; // an API call has no "no access" to show
      const diff = screenDifferences(screen)[lane.user] ?? [];
      boxes.push({
        id: idOf(key, lane.user),
        screen,
        user: lane.user,
        nodes,
        ghost: nodes.length === 0,
        x: (x.get(key) ?? 0) * (BOX_W + COL_GAP),
        y: lane.top + LANE_HEAD + (y.get(key) ?? 0),
        h: heightOf(screen),
        only: diff,
      });
    }
  }
  const real = new Set(boxes.filter((b) => !b.ghost).map((b) => b.id));
  const arrows: Arrow[] = [];
  for (const t of flow.transitions) {
    if ((col.get(t.to) ?? 0) <= (col.get(t.from) ?? 0)) continue; // going back ("voltar") adds noise, not information
    for (const u of users) {
      if (!t.users.includes(u) && !(t.users.includes(NO_USER) && u === NO_USER)) continue;
      const from = idOf(t.from, u);
      const to = idOf(t.to, u);
      if (real.has(from) && real.has(to)) arrows.push({ id: `${t.id}@${u}`, from, to, label: arrowText(t), kind: t.kind, user: u });
    }
  }
  return { lanes, boxes, arrows, width: columnCount * BOX_W + Math.max(0, columnCount - 1) * COL_GAP, height: lanes.length * (laneHeight + 16) };
}

/** What each box got in the last test: a run's own verdicts for a run flow, the map's latest ones otherwise. */
export function boxTones(layout: Layout, results: Record<string, NodeResult> | undefined, coverage: Record<string, NodeCoverage> | undefined): Record<string, Tone> {
  const out: Record<string, Tone> = {};
  for (const b of layout.boxes) {
    if (b.ghost) continue;
    const softError = b.nodes.some((n) => typeof n.metadata["soft_error"] === "string");
    out[b.id] = toneOf(softError, worstResult(b.nodes, results), b.nodes.map((n) => coverage?.[n.id]).find((c) => c !== undefined));
  }
  return out;
}

const RANK: Record<NodeResult, number> = { error: 3, fail: 3, pass: 1, skipped: 0 };

/**
 * Which node of a box stands for it: the one that did worst in the last test (so a failing screen shows the page that
 * failed, with its own picture and history), else one that has a picture, else the first.
 */
export function boxFocus(layout: Layout, results: Record<string, NodeResult> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of layout.boxes) {
    if (b.nodes.length === 0) continue;
    const ranked = [...b.nodes].sort((a, c) => (results?.[c.id] ? RANK[results[c.id] as NodeResult] : -1) - (results?.[a.id] ? RANK[results[a.id] as NodeResult] : -1));
    const worst = ranked[0];
    const failing = worst && results?.[worst.id] && RANK[results[worst.id] as NodeResult] >= 3 ? worst : undefined;
    out[b.id] = (failing ?? b.nodes.find((n) => n.has_thumbnail) ?? b.nodes[0])?.id ?? "";
  }
  return out;
}
