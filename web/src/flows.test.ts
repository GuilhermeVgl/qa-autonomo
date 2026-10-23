import { describe, expect, it } from "vitest";
import type { GraphData, GraphEdge, GraphNode } from "./api";
import { BOX_H, BOX_W, ENDPOINT_H, MAX_ROWS, arrowText, boxFocus, boxPossibilities, boxTones, buildModel, detectJourneys, layoutFlow, requirementFlows, runFlow, screenDifferences } from "./flows";

const node = (id: string, kind: string, label: string, roles: string[], metadata: Record<string, unknown> = {}): GraphNode => ({ id, kind, label, app_roles: roles, metadata });
const edge = (id: string, from: string, to: string, role: string, action: Record<string, unknown>): GraphEdge => ({ id, from_node_id: from, to_node_id: to, key: id, action, app_roles: [role] });

const controls = (...labels: string[]) => ({ controls: labels.map((label) => ({ label })) });
const forms = (...defs: Array<{ label: string; method: string; action: string }>) => ({ forms: defs.map((d) => ({ ...d })) });

const GRAPH: GraphData = {
  graph: { id: "g", version: 1 },
  nodes: [
    node("home-a", "page", "/", ["admin"]),
    node("cl-a", "page", "/clients", ["admin"], { ...controls("Novo cliente", "Excluir cliente"), ...forms({ label: "Novo cliente", method: "POST", action: "/clients" }) }),
    node("cl-o", "page", "/clients", ["operador"], { ...controls("Novo cliente"), ...forms({ label: "Buscar clientes", method: "GET", action: "/clients" }) }),
    node("modal-a", "modal", "/clients › Novo cliente", ["admin"]),
    node("modal-o", "modal", "/clients › Novo cliente", ["operador"]),
    node("post", "endpoint", "POST /clients", ["admin", "operador"]),
    node("show-a", "page", "/clients/:id", ["admin"]),
    node("adm-a", "page", "/admin", ["admin"]),
  ],
  edges: [
    edge("e1", "home-a", "cl-a", "admin", { type: "navigate", label: "Clientes" }),
    edge("e2", "cl-a", "home-a", "admin", { type: "navigate", label: "Início" }), // back
    edge("e3", "cl-a", "modal-a", "admin", { type: "click", label: "Novo cliente", intent: "open" }),
    edge("e4", "cl-o", "modal-o", "operador", { type: "click", label: "Novo cliente", intent: "open" }),
    edge("e5", "modal-a", "post", "admin", { type: "request", method: "POST", path: "/clients", trigger: "Salvar", blocked: true }),
    edge("e6", "modal-o", "post", "operador", { type: "request", method: "POST", path: "/clients", trigger: "Salvar" }),
    edge("e7", "cl-a", "show-a", "admin", { type: "submit", label: "Novo cliente" }),
    edge("e8", "home-a", "adm-a", "admin", { type: "navigate", label: "Admin" }),
  ],
} as unknown as GraphData;

describe("buildModel", () => {
  const m = buildModel(GRAPH);

  it("makes one screen of the nodes of every user that share a route", () => {
    const clients = m.screens.get("page|/clients");
    expect(Object.keys(clients?.cells ?? {})).toEqual(["admin", "operador"]);
    expect(m.screens.get("endpoint|POST /clients")?.cells["operador"]?.[0]?.id).toBe("post"); // an endpoint found by two users is in both lanes
    expect(m.screenOf.get("cl-o")).toBe("page|/clients");
  });

  it("turns edges into transitions in plain words, merging what several users did", () => {
    const labels = m.transitions.map((t) => `${t.kind}: ${t.label}`).sort();
    expect(labels).toContain("open: abre “Novo cliente”");
    expect(labels).toContain("submit: envia “Novo cliente”");
    expect(labels).toContain("link: vai para “Clientes”");
    const call = m.transitions.filter((t) => t.kind === "request");
    expect(call).toHaveLength(2); // blocked for one, not for the other: told apart
    expect(call.map((t) => t.label).sort()).toEqual(["Salvar → POST /clients", "Salvar → POST /clients (bloqueada)"]);
    const open = m.transitions.find((t) => t.kind === "open");
    expect(open?.users).toEqual(["admin", "operador"]);
  });

  it("ignores edges to nodes that are not screens, and self loops", () => {
    const g = { ...GRAPH, nodes: [...GRAPH.nodes, node("cmd", "command", "cli run", [])], edges: [...GRAPH.edges, edge("x", "cl-a", "cmd", "admin", { type: "navigate" }), edge("y", "cl-a", "cl-o", "admin", { type: "navigate" })] };
    expect(buildModel(g).transitions.some((t) => t.to.startsWith("command"))).toBe(false);
    expect(buildModel(g).transitions.some((t) => t.from === t.to)).toBe(false);
  });
});

describe("detectJourneys", () => {
  const m = buildModel(GRAPH);
  const journeys = detectJourneys(m);

  it("finds stories from screens with outgoing possibilities, including navigation", () => {
    expect(journeys.map((j) => j.title)).toEqual(["/", "/clients"]);
    const j = journeys[0];
    expect(j?.screens).toEqual(["page|/", "page|/clients", "page|/admin", "modal|/clients › Novo cliente", "page|/clients/:id"]);
    expect(j?.transitions.some((t) => t.kind === "link")).toBe(true);
    expect(j?.subtitle).toContain("vai para “Clientes”");
    expect(j?.origin).toBe("journey");
  });

  it("knows which users the flow involves and how many screens not all of them reach", () => {
    const j = journeys.find((f) => f.title === "/clients");
    expect(j?.users).toEqual(["admin", "operador"]);
    expect(j?.partial).toBe(3);
  });
});

describe("flows and specifications", () => {
  const covered = (n: GraphNode, keys: string[]): GraphNode => ({ ...n, requirement_count: keys.length, requirement_keys: keys });
  const g = {
    ...GRAPH,
    nodes: GRAPH.nodes.map((n) => (n.id === "cl-a" ? covered(n, ["REQ-001", "PAGE /clients"]) : n.id === "cl-o" ? covered(n, ["PAGE /clients"]) : n)),
  } as GraphData;

  it("counts the screens of a flow that no requirement talks about", () => {
    const model = buildModel(g);
    const journey = detectJourneys(model).find((f) => f.title === "/clients");
    expect(journey?.uncovered).toEqual(["page|/", "page|/clients/:id", "page|/admin"]);
  });

  it("a screen is covered when any user's node of it is", () => {
    const model = buildModel(g);
    expect(model.screens.get("page|/clients")?.requirements).toEqual(["PAGE /clients", "REQ-001"]); // both users' keys, once each
    expect(model.screens.get("page|/clients/:id")?.requirements).toEqual([]);
  });

  it("a flow with every page covered has nothing uncovered", () => {
    const all = { ...g, nodes: g.nodes.map((n) => (n.kind === "page" && !(n.requirement_count ?? 0) ? covered(n, ["PAGE x"]) : n)) } as GraphData;
    const [journey] = detectJourneys(buildModel(all));
    expect(journey?.uncovered).toEqual([]);
  });
});

describe("requirementFlows", () => {
  it("builds a flow from the screens a requirement is linked to, and what can be done from them", () => {
    const m = buildModel(GRAPH);
    const [f] = requirementFlows(m, [{ key: "FORM POST /clients", text: "O formulário aceita dados válidos", node_ids: ["cl-a"] }, { key: "REQ-9", text: "x", node_ids: ["ghost"] }]);
    expect(f).toMatchObject({ id: "req:FORM POST /clients", origin: "requirement", title: "FORM POST /clients", start: ["page|/clients"] });
    expect(f?.screens).toContain("page|/clients/:id");
    expect(f?.screens).not.toContain("endpoint|POST /clients");
    expect(requirementFlows(m, [{ key: "REQ-9", text: "x", node_ids: ["ghost"] }])).toEqual([]); // nothing of it on the map
  });

  it("starts from every screen a requirement covers, so one covered for two users shows both", () => {
    const m = buildModel(GRAPH);
    const [f] = requirementFlows(m, [{ key: "R", text: "t", node_ids: ["cl-a", "cl-o"] }]);
    expect(f?.start).toEqual(["page|/clients"]);
    expect(f?.users).toEqual(["admin", "operador"]);
  });
});

describe("runFlow", () => {
  const m = buildModel(GRAPH);

  it("is the screens a run tested, joined by the ways between them, with the worst verdict of each", () => {
    const flow = runFlow(m, [
      { node_id: "home-a", result: "pass" },
      { node_id: "cl-a", result: "pass" },
      { node_id: "cl-a", result: "fail" }, // a form of the same screen failed
      { node_id: "cl-o", result: "pass" },
      { node_id: null, result: "pass" },
    ], "Regressão", "como admin e operador");
    expect(flow?.screens.sort()).toEqual(["page|/", "page|/clients"]);
    expect(flow?.results).toEqual({ "home-a": "pass", "cl-a": "fail", "cl-o": "pass" });
    expect(flow?.start).toEqual(["page|/"]); // nothing else in the run leads to it
    expect(flow?.users).toEqual(["admin", "operador"]);
    expect(flow?.origin).toBe("run");
  });

  it("is nothing when the run tested nothing on the map", () => {
    expect(runFlow(m, [], "r", "")).toBeNull();
    expect(runFlow(m, [{ node_id: "unknown", result: "pass" }], "r", "")).toBeNull();
  });
});

describe("screenDifferences", () => {
  it("says what only one user has on a screen several users reach", () => {
    const clients = buildModel(GRAPH).screens.get("page|/clients");
    expect(screenDifferences(clients as never)).toEqual({ admin: ["Excluir cliente", "formulário Novo cliente"], operador: ["formulário Buscar clientes"] });
  });

  it("says nothing for a screen one user reaches, or when they have the same", () => {
    const m = buildModel(GRAPH);
    expect(screenDifferences(m.screens.get("page|/admin") as never)).toEqual({});
    const same = buildModel({
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "cl-o"
          ? { ...n, metadata: { ...controls("Novo cliente", "Excluir cliente"), ...forms({ label: "Novo cliente", method: "POST", action: "/clients" }) } }
          : n,
      ),
    });
    expect(screenDifferences(same.screens.get("page|/clients") as never)).toEqual({});
  });

  it("counts forms as capabilities too", () => {
    const g = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "cl-a" ? { ...n, metadata: { ...controls("Novo cliente"), forms: [{ method: "POST", action: "/clients", label: "Importar planilha" }] } } : n)) };
    expect(screenDifferences(buildModel(g).screens.get("page|/clients") as never)).toEqual({ admin: ["formulário Importar planilha"], operador: ["formulário Buscar clientes"] });
  });
});

describe("layoutFlow", () => {
  const m = buildModel(GRAPH);
  const flow = detectJourneys(m).find((f) => f.title === "/clients") as NonNullable<ReturnType<typeof detectJourneys>[number]>;
  const layout = layoutFlow(m, flow);
  const box = (key: string, user: string) => layout.boxes.find((b) => b.id === `${key}@${user}`);

  it("has one lane per user, the same columns in each", () => {
    expect(layout.lanes.map((l) => l.user)).toEqual(["admin", "operador"]);
    const a = box("page|/clients", "admin");
    const o = box("page|/clients", "operador");
    expect(a?.x).toBe(0);
    expect(o?.x).toBe(0);
    expect(box("modal|/clients › Novo cliente", "admin")?.x).toBeGreaterThan(a?.x ?? 0);
    expect(box("modal|/clients › Novo cliente", "admin")?.x).toBe(box("modal|/clients › Novo cliente", "operador")?.x);
    expect(o?.y).toBeGreaterThan(a?.y ?? 0); // the operator's lane is below the admin's
  });

  it("shows a screen a user cannot reach as a ghost in their lane, so a missing permission is visible", () => {
    const ghost = box("page|/admin", "operador");
    expect(ghost).toMatchObject({ ghost: true, nodes: [] });
    expect(box("page|/admin", "admin")?.ghost).toBe(false);
    expect(layout.boxes.some((b) => b.screen.kind === "endpoint")).toBe(false);
  });

  it("marks what only one user has on a screen they share", () => {
    expect(box("page|/clients", "admin")?.only).toEqual(["Excluir cliente", "formulário Novo cliente"]);
    expect(box("page|/clients", "operador")?.only).toEqual(["formulário Buscar clientes"]);
  });

  it("draws arrows inside each lane only, between the boxes the user really has", () => {
    const admin = layout.arrows.filter((a) => a.user === "admin");
    const operador = layout.arrows.filter((a) => a.user === "operador");
    expect(admin.map((a) => a.label).sort()).toEqual(["abre “Novo cliente”", "envia “Novo cliente”", "vai para “Admin”", "vai para “Início”"]);
    expect(operador.map((a) => a.label).sort()).toEqual(["abre “Novo cliente”"]); // no link to /admin, no submit to /clients/:id
    for (const a of layout.arrows) expect(a.from.endsWith(`@${a.user}`) && a.to.endsWith(`@${a.user}`)).toBe(true);
  });

  it("spreads branches of the same column down, within the lane", () => {
    const col2 = layout.boxes.filter((b) => b.user === "admin" && b.x === box("modal|/clients › Novo cliente", "admin")?.x);
    expect(new Set(col2.map((b) => b.y)).size).toBe(col2.length);
    expect(layout.height).toBeGreaterThan(BOX_H * 2);
    expect(layout.width).toBeGreaterThanOrEqual(BOX_W * 3);
  });

  it("keeps an API call compact, so a screen that calls many endpoints does not become a tall strip", () => {
    const page = layout.boxes.find((b) => b.screen.kind === "page");
    expect(layout.boxes.some((b) => b.screen.kind === "endpoint")).toBe(false);
    expect(page?.h).toBe(BOX_H);
    expect(ENDPOINT_H).toBeLessThan(BOX_H / 2);
  });

  it("wraps a crowded column into more columns instead of one tall stack, the same for every lane", () => {
    const many: GraphNode[] = [node("home", "page", "/", ["admin", "operador"])];
    const manyEdges: GraphEdge[] = [];
    for (let i = 0; i < MAX_ROWS * 2 + 1; i++) {
      for (const u of ["admin", "operador"]) {
        many.push(node(`p${i}-${u}`, "page", `/p${i}`, [u]));
        manyEdges.push(edge(`l${i}-${u}`, "home-" + u, `p${i}-${u}`, u, { type: "navigate", label: `P${i}` }));
      }
    }
    many.push(node("home-admin", "page", "/", ["admin"]), node("home-operador", "page", "/", ["operador"]));
    const g = { graph: { id: "g", version: 1 }, nodes: many.filter((n) => n.id !== "home"), edges: manyEdges } as unknown as GraphData;
    const mm = buildModel(g);
    const f = { id: "f", origin: "run" as const, title: "t", subtitle: "", start: ["page|/"], screens: [...mm.screens.keys()], transitions: mm.transitions, users: ["admin", "operador"], partial: 0, uncovered: [] };
    const l = layoutFlow(mm, f);
    const admin = l.boxes.filter((b) => b.user === "admin" && b.screen.route !== "/");
    const xs = [...new Set(admin.map((b) => b.x))];
    expect(xs.length).toBe(3); // 9 screens, 4 per column
    for (const x of xs) expect(admin.filter((b) => b.x === x).length).toBeLessThanOrEqual(MAX_ROWS);
    // the operator's lane has the same columns and the same row offsets within its lane
    const op = l.boxes.filter((b) => b.user === "operador" && b.screen.route !== "/");
    expect([...new Set(op.map((b) => b.x))].sort()).toEqual([...xs].sort());
    const [first, second] = l.lanes;
    const laneOffset = (second?.top ?? 0) - (first?.top ?? 0);
    for (const a of admin) expect(op.find((b) => b.screen.key === a.screen.key)?.y).toBe(a.y + laneOffset);
    expect(l.height).toBeLessThan(MAX_ROWS * BOX_H * 2 + 400);
  });

  it("does not draw a way back to an earlier column", () => {
    const all = buildModel(GRAPH);
    const flowWithBack = { ...flow, screens: ["page|/", "page|/clients"], start: ["page|/"], transitions: all.transitions.filter((t) => (t.from === "page|/" && t.to === "page|/clients") || (t.from === "page|/clients" && t.to === "page|/")) };
    const l = layoutFlow(all, { ...flowWithBack, users: ["admin"] });
    expect(l.arrows.map((a) => a.label)).toEqual(["vai para “Clientes”"]); // "Início" goes back: left out
  });

  it("copes with a flow that has a cycle and with an empty one", () => {
    const cyc = layoutFlow(m, { ...flow, transitions: [...flow.transitions, { id: "loop", from: "page|/clients/:id", to: "page|/clients", kind: "click", label: "volta", users: ["admin"] }] });
    expect(cyc.boxes.length).toBeGreaterThan(0);
    expect(layoutFlow(m, { ...flow, screens: [], transitions: [], start: [], users: [] })).toMatchObject({ lanes: [], boxes: [], arrows: [] });
  });
});

describe("arrowText", () => {
  it("keeps what triggered a call (the endpoint is on its own card) and leaves other arrows as they are", () => {
    expect(arrowText({ kind: "request", label: "Salvar → POST /clients (bloqueada)" })).toBe("Salvar");
    expect(arrowText({ kind: "request", label: "POST /clients" })).toBe("chama a API");
    expect(arrowText({ kind: "submit", label: "envia “Novo cliente”" })).toBe("envia “Novo cliente”");
  });
});

describe("boxTones", () => {
  const m = buildModel(GRAPH);
  const flow = detectJourneys(m)[0] as NonNullable<ReturnType<typeof detectJourneys>[number]>;
  const layout = layoutFlow(m, flow);

  it("colors each box by the last verdict of its own nodes, falling back to coverage", () => {
    const tones = boxTones(layout, { "cl-a": "fail", "cl-o": "pass", "show-a": "skipped" }, { "modal-a": "covered", "modal-o": "no_spec" });
    expect(tones["page|/clients@admin"]).toBe("failing");
    expect(tones["page|/clients@operador"]).toBe("passed"); // same screen, another user, another verdict
    expect(tones["page|/clients/:id@admin"]).toBe("skipped");
    expect(tones["modal|/clients › Novo cliente@admin"]).toBe("covered");
    expect(tones["modal|/clients › Novo cliente@operador"]).toBe("no_spec");
    expect(tones["page|/clients/:id@operador"]).toBeUndefined(); // a ghost has no verdict
  });

  it("shows a screen that answers 200 but displays an error as failing", () => {
    const g = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "cl-a" ? { ...n, metadata: { ...n.metadata, soft_error: "Something went wrong" } } : n)) };
    const mm = buildModel(g);
    const l = layoutFlow(mm, detectJourneys(mm)[0] as never);
    expect(boxTones(l, { "cl-a": "pass" }, undefined)["page|/clients@admin"]).toBe("failing");
  });
});

describe("boxFocus", () => {
  it("stands for a box with the node that failed, then one with a picture, then the first", () => {
    const g = {
      graph: { id: "g", version: 1 },
      nodes: [
        { ...node("c1", "page", "/customers/:id", ["admin"]), has_thumbnail: true },
        node("c3", "page", "/customers/:id", ["admin"]),
        node("c4", "page", "/customers/:id", ["admin"]),
        node("l", "page", "/login", ["admin"]),
      ],
      edges: [],
    } as unknown as GraphData;
    const m = buildModel(g);
    const flow = { id: "f", origin: "run" as const, title: "", subtitle: "", start: [...m.screens.keys()], screens: [...m.screens.keys()], transitions: [], users: ["admin"], partial: 0, uncovered: [] };
    const layout = layoutFlow(m, flow);
    expect(boxFocus(layout, { c1: "pass", c3: "fail", c4: "pass" })["page|/customers/:id@admin"]).toBe("c3");
    expect(boxFocus(layout, { c1: "pass", c3: "pass" })["page|/customers/:id@admin"]).toBe("c1"); // none failed: the one with a picture
    expect(boxFocus(layout, undefined)["page|/customers/:id@admin"]).toBe("c1");
    expect(boxFocus(layout, undefined)["page|/login@admin"]).toBe("l");
  });
});

describe("boxPossibilities", () => {
  it("builds possibilities from forms, controls and transitions and overlays test verdict", () => {
    const model = buildModel(GRAPH);
    const flow = detectJourneys(model).find((f) => f.title === "/clients") as NonNullable<ReturnType<typeof detectJourneys>[number]>;
    const layout = layoutFlow(model, flow);
    const admin = layout.boxes.find((b) => b.id === "page|/clients@admin") as NonNullable<(typeof layout.boxes)[number]>;
    const operador = layout.boxes.find((b) => b.id === "page|/clients@operador") as NonNullable<(typeof layout.boxes)[number]>;
    const adminPoss = boxPossibilities(admin, { "cl-a": "fail" });
    const operadorPoss = boxPossibilities(operador, undefined);

    expect(adminPoss.some((p) => p.kind === "submit" && p.label.includes("Novo cliente"))).toBe(true);
    expect(adminPoss.some((p) => p.kind === "open" && p.label.includes("Novo cliente"))).toBe(true);
    expect(adminPoss.some((p) => p.kind === "action" && p.label.includes("Excluir cliente"))).toBe(true);
    expect(adminPoss.every((p) => p.result === "fail" && p.tested)).toBe(true);

    expect(operadorPoss.some((p) => p.kind === "search" && p.label.includes("Buscar clientes"))).toBe(true);
    expect(operadorPoss.every((p) => p.result === "untested" && !p.tested)).toBe(true);
  });
});
