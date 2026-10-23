import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./GraphView", () => ({
  GraphView: ({ results, coverage, graph }: { results?: unknown; coverage?: unknown; graph?: { nodes: { label: string }[] } }) => (
    <div data-testid="graph" data-results={JSON.stringify(results ?? null)} data-coverage={JSON.stringify(coverage ?? null)} data-labels={(graph?.nodes ?? []).map((n) => n.label).join(",")} />
  ),
}));
vi.mock("./useGraphStream", () => ({ useGraphStream: () => undefined }));
vi.mock("./FlowChart", () => ({
  FlowChart: ({ layout, tones, onSelect }: { focus?: unknown; layout: { boxes: { id: string; user: string; ghost: boolean; screen: { route: string } }[]; arrows: { id: string; user: string; label: string }[] }; tones: Record<string, string>; onSelect: (b: unknown) => void }) => (
    <div data-testid="flow-chart">
      {layout.boxes.map((b) => (
        <button key={b.id} type="button" data-ghost={b.ghost} data-tone={tones[b.id] ?? ""} onClick={() => onSelect(b)}>
          {`${b.user}: ${b.screen.route}`}
        </button>
      ))}
      <ul aria-label="setas">
        {layout.arrows.map((a) => (
          <li key={a.id}>{`${a.user} | ${a.label}`}</li>
        ))}
      </ul>
    </div>
  ),
}));

const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** A page of steps, with the total the server reports in a header. */
const page = (items: unknown[], total = items.length) => new Response(JSON.stringify(items), { status: 200, headers: { "X-Total-Count": String(total) } });

function stubApi(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET" });
      const handler = routes[path];
      return handler ? handler(init) : json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("qa_token", "dev:ana@x.com");
  window.location.hash = "";
});
afterEach(() => vi.unstubAllGlobals());

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const GRAPH = {
  graph: { id: "g1", version: 1 },
  nodes: [
    { id: "n1", kind: "page", label: "/orders", app_roles: ["admin"], metadata: {}, requirement_count: 2 },
    { id: "n2", kind: "page", label: "/reports", app_roles: ["admin"], metadata: {}, requirement_count: 0 },
  ],
  edges: [],
};
const RUNS = [
  { id: "r2", type: "regression", trigger: "ci", status: "failed", summary: {}, created_at: ago(3_600_000), started_at: ago(3_590_000), finished_at: ago(3_500_000) },
  { id: "r1", type: "exploration", trigger: "manual", status: "succeeded", summary: { pages: 12 }, created_at: ago(86_400_000), started_at: ago(86_300_000), finished_at: ago(86_000_000) },
];
const BUGS = [
  { id: "b1", title: "REQ-001 · /orders: HTTP 500", status: "new", severity: "critical" },
  { id: "b2", title: "REQ-002 · /reports: layout", status: "fixed", severity: "high" },
];
const FULL = {
  "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
  "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
  "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
  "/api/v1/environments/e1/credentials": () => json([{ id: "c1", app_role: "admin", kind: "login" }]),
  "/api/v1/environments/e1/graph": () => json(GRAPH),
  "/api/v1/environments/e1/runs": () => json(RUNS),
  "/api/v1/projects/p1/specs": () =>
    json([
      { id: "s2", version: 2, title: "Regras v2", source_type: "text" },
      { id: "s1", version: 1, title: "Regras v1", source_type: "text" },
    ]),
  "/api/v1/specs/s2/requirements": () =>
    json([
      { id: "q1", key: "REQ-001", text: "Listar pedidos", criticality: "critical", status: "unchanged" },
      { id: "q2", key: "REQ-002", text: "Emitir relatório mensal", criticality: "normal", status: "new" },
    ]),
  "/api/v1/specs/s1/requirements": () => json([{ key: "REQ-001", text: "Listar pedidos (antigo)", criticality: "critical" }]),
  "/api/v1/specs/s2/coverage?graph_id=g1": () =>
    json({
      requirements: [
        { key: "REQ-001", text: "Listar pedidos", criticality: "critical", status: "covered", node_ids: ["n1"] },
        { key: "REQ-002", text: "Emitir relatório mensal", criticality: "normal", status: "unmatched", node_ids: [] },
      ],
      nodes: [
        { node_id: "n1", label: "/orders", status: "covered", requirement_keys: ["REQ-001"] },
        { node_id: "n2", label: "/reports", status: "no_spec", requirement_keys: [] },
      ],
    }),
  "/api/v1/environments/e1/node-status": () => json([{ node_id: "n1", run_id: "r2", status: "fail", passed: 1, failed: 1, errored: 0, skipped: 0, at: new Date().toISOString() }]),
  "/api/v1/environments/e1/capabilities": () =>
    json({
      graph_id: "g1",
      generated_at: new Date().toISOString(),
      capabilities: [
        {
          id: "orders",
          name: "Orders",
          description: "Telas de pedidos.",
          criticality: "normal",
          source: "agent",
          nodes_total: 2,
          nodes_covered: 1,
          nodes_tested: 1,
          status: "fail",
          nodes: [],
        },
      ],
    }),
  "/api/v1/specs/s2/pendencies": () => json([]),
  "/api/v1/projects/p1/bugs": () => json(BUGS),
  "/api/v1/runs/r2/report": () =>
    json({
      run: { id: "r2", type: "regression", status: "failed", duration_seconds: 90 },
      steps: { pass: 8, fail: 2, error: 0, skipped: 1 },
      requirements: [],
      bugs: { new: [{ id: "b1" }], recurring: [], fixed: [] },
      cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
    }),
  "/api/v1/runs/r1/report": () =>
    json({
      run: { id: "r1", type: "exploration", status: "succeeded", duration_seconds: 300 },
      steps: {},
      requirements: [],
      bugs: { new: [], recurring: [], fixed: [] },
      cost: { llm_calls: 4, tokens_in: 900, tokens_out: 90, cost: 0 },
    }),
};

describe("visão geral", () => {
  it("guia a configuração inicial quando o espaço de trabalho está vazio", async () => {
    window.location.hash = "#/";
    stubApi({ "/api/v1/me": FULL["/api/v1/me"], "/api/v1/projects": () => json([]) });
    render(wrap(<App />));
    const steps = await screen.findByRole("region", { name: "Primeiros passos" });
    expect(within(steps).getByText("0 de 5")).toBeInTheDocument();
    expect(within(steps).getByRole("button", { name: "Criar projeto" })).toBeEnabled();
    expect(within(steps).getByRole("button", { name: "Criar ambiente" })).toBeDisabled(); // needs a project first
    await userEvent.click(within(steps).getByRole("button", { name: "Criar projeto" }));
    expect(window.location.hash).toBe("#/config/projetos");
    expect(await screen.findByRole("tab", { name: "Projetos", selected: true })).toBeInTheDocument();
  });

  it("mostra os indicadores do projeto e some com os primeiros passos quando tudo está feito", async () => {
    window.location.hash = "#/";
    stubApi(FULL);
    render(wrap(<App />));
    expect(await screen.findByText("Olá, ana")).toBeInTheDocument();
    const cover = screen.getByRole("region", { name: "Cobertura" });
    await within(cover).findByText(/1 de 2/);
    expect(screen.queryByRole("region", { name: "Primeiros passos" })).not.toBeInTheDocument();
    const bugs = await screen.findByRole("region", { name: "Bugs abertos" });
    expect(await within(bugs).findByText("1 crítico")).toBeInTheDocument();
    expect(within(bugs).getByText("1")).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Execuções recentes" });
    expect(within(recent).getByText("Regressão")).toBeInTheDocument();
    expect(within(recent).getByText("Falhou")).toBeInTheDocument();
    expect(within(recent).getByText("Concluído")).toBeInTheDocument();
    const caps = screen.getByRole("region", { name: "Capacidades" });
    expect(within(caps).getByText("1 / 1")).toBeInTheDocument();
    expect(within(caps).getByText("1 com falha")).toBeInTheDocument();
  });
});

describe("navegação", () => {
  it("troca de página pelo menu lateral e marca a atual", async () => {
    window.location.hash = "#/";
    stubApi(FULL);
    render(wrap(<App />));
    const nav = await screen.findByRole("navigation", { name: "Navegação" });
    expect(within(nav).getByRole("link", { name: /Visão geral/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("link", { name: /Especificações/ }));
    expect(await screen.findByRole("region", { name: "Requisitos" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Especificações/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Bugs/ })).toHaveTextContent("1"); // open bugs badge
    expect(document.title).toBe("Especificações · QA Autônomo");
  });

  it("abre direto na página do endereço", async () => {
    window.location.hash = "#/bugs";
    stubApi(FULL);
    render(wrap(<App />));
    expect(await screen.findByText("REQ-001 · /orders: HTTP 500")).toBeInTheDocument();
  });

  it("abre a página Produto pelo menu e mostra capacidades", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    const nav = await screen.findByRole("navigation", { name: "Navegação" });
    await userEvent.click(within(nav).getByRole("link", { name: /Produto/ }));
    expect(await screen.findByText("Capacidades de negócio inferidas a partir do mapa explorado.")).toBeInTheDocument();
    expect(await screen.findByText("Orders")).toBeInTheDocument();
    expect(await screen.findByText("2 tela(s)")).toBeInTheDocument();
  });

  it("troca o tema pelo menu lateral", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    await screen.findByRole("navigation", { name: "Navegação" });
    await userEvent.click(screen.getByRole("radio", { name: "Tema escuro" }));
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: "Tema claro" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });
});

describe("mapa colorido", () => {
  beforeEach(() => {
    window.location.hash = "#/mapa";
  });

  it("entrega ao grafo o resultado do último teste e a cobertura vinda dos requisitos de qualquer spec", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    const graph = await screen.findByTestId("graph");
    await waitFor(() => expect(JSON.parse(graph.getAttribute("data-results") ?? "null")).toEqual({ n1: "fail" }));
    // n1 has requirements (even if only the generated spec has them), n2 has none
    expect(JSON.parse(graph.getAttribute("data-coverage") ?? "null")).toEqual({ n1: "covered", n2: "no_spec" });
  });

  it("não fica cinza quando só existe a spec automática", async () => {
    stubApi({ ...FULL, "/api/v1/projects/p1/specs": () => json([{ id: "s3", version: 1, title: "Varredura automática", source_type: "auto" }]) });
    render(wrap(<App />));
    const graph = await screen.findByTestId("graph");
    await waitFor(() => expect(JSON.parse(graph.getAttribute("data-coverage") ?? "null")).toEqual({ n1: "covered", n2: "no_spec" }));
  });
});

const FLOW_GRAPH = {
  graph: { id: "g1", version: 1 },
  nodes: [
    { id: "cl-a", kind: "page", label: "/clients", app_roles: ["admin"], metadata: { controls: [{ label: "Novo cliente" }, { label: "Excluir cliente" }] }, requirement_count: 1, requirement_keys: ["PAGE /clients"], has_thumbnail: true },
    { id: "cl-o", kind: "page", label: "/clients", app_roles: ["operador"], metadata: { controls: [{ label: "Novo cliente" }] }, requirement_count: 1, requirement_keys: ["PAGE /clients"] },
    { id: "modal-a", kind: "modal", label: "/clients › Novo cliente", app_roles: ["admin"], metadata: {} },
    { id: "modal-o", kind: "modal", label: "/clients › Novo cliente", app_roles: ["operador"], metadata: {} },
    { id: "show-a", kind: "page", label: "/clients/:id", app_roles: ["admin"], metadata: {} },
    { id: "home", kind: "page", label: "/", app_roles: ["admin"], metadata: {} },
  ],
  edges: [
    { id: "e1", from_node_id: "cl-a", to_node_id: "modal-a", key: "open", action: { type: "click", label: "Novo cliente", intent: "open" }, app_roles: ["admin"] },
    { id: "e2", from_node_id: "cl-o", to_node_id: "modal-o", key: "open", action: { type: "click", label: "Novo cliente", intent: "open" }, app_roles: ["operador"] },
    { id: "e3", from_node_id: "cl-a", to_node_id: "show-a", key: "submit", action: { type: "submit", label: "Novo cliente" }, app_roles: ["admin"] },
    { id: "e4", from_node_id: "home", to_node_id: "cl-a", key: "link", action: { type: "navigate", label: "Clientes" }, app_roles: ["admin"] },
  ],
};

const BRIEF = {
  facts: {
    generated_at: "2026-10-05T14:30:00Z",
    project: "Portal",
    environment: { name: "hml", base_url: "http://a", destructive_policy: "block", kind: "web" },
    users: ["admin"],
    map: { explored: true, pages: 2, screens: 2, modals: 0, endpoints: 0, commands: 0, with_picture: 2, screens_by_user: { admin: 2 } },
    specs: [{ title: "Regras v2", source: "text", requirements: 2, by_criticality: { critical: 1 }, unlinked: 1, need_review: 0 }],
    coverage: { requirements: 2, linked: 1, percent_requirements: 50, unlinked: [{ spec: "Regras v2", key: "REQ-002", text: "Emitir relatório", criticality: "normal" }], screens: 2, screens_covered: 1, percent_screens: 50, screens_without_requirement: ["/reports"] },
    regression: null,
    bugs: { open: 0, critical: 0, high: 0, fixed: 0, list: [] },
    access: [],
    journeys: { count: 0, routes: [], without_requirement: [] },
    open_pendencies: 0,
    issues: [{ code: "requirements_unlinked", severity: "média", area: "especificação", message: "1 requisito não está ligado a nenhuma tela: não serão testados.", items: ["REQ-002: Emitir relatório"] }],
    readiness: [
      { id: "runner", label: "Runner conectado", ok: true, detail: "Há um runner ativo." },
      { id: "llm", label: "Modelo de IA configurado", ok: true, detail: "Pode usar IA." },
    ],
  },
  narrative: {
    source: "template",
    executive_summary: "No ambiente hml foram mapeadas 2 telas.",
    sections: [{ id: "scope", title: "Escopo e método", body: "Ambiente **hml**." }],
    recommendations: ["Ligar o REQ-002 a uma tela."],
  },
};

describe("limpeza de usabilidade", () => {
  it("a visão geral mede a cobertura contra a spec automática quando ninguém escreveu uma", async () => {
    window.location.hash = "#/";
    stubApi({
      ...FULL,
      "/api/v1/projects/p1/specs": () => json([{ id: "s3", version: 1, title: "Varredura automática · hml", source_type: "auto", environment_id: "e1" }]),
      "/api/v1/specs/s3/coverage?graph_id=g1": () =>
        json({ requirements: [{ key: "PAGE /orders", text: "t", criticality: "normal", status: "covered", node_ids: ["n1"] }, { key: "PAGE /reports", text: "t", criticality: "normal", status: "unmatched", node_ids: [] }], nodes: [] }),
      "/api/v1/specs/s3/pendencies": () => json([]),
      "/api/v1/environments/e1/brief": () => json(BRIEF),
    });
    render(wrap(<App />));
    const card = await screen.findByRole("region", { name: "Cobertura" });
    expect(await within(card).findByText("1 de 2")).toBeInTheDocument();
    expect(within(card).getByText(/em “Varredura automática · hml”/)).toBeInTheDocument();
    expect(within(card).queryByText(/Envie uma especificação/)).not.toBeInTheDocument();
  });

  it("na spec automática as linhas não levam o selo de novo/alterado (ela é refeita a cada exploração)", async () => {
    window.location.hash = "#/specs";
    stubApi({
      ...FULL,
      "/api/v1/projects/p1/specs": () => json([{ id: "s3", version: 3, title: "Varredura automática · hml", source_type: "auto", environment_id: "e1" }]),
      "/api/v1/specs/s3/requirements": () => json([{ id: "q9", key: "PAGE /orders", text: "A tela /orders responde sem erro", criticality: "normal", status: "new" }]),
    });
    render(wrap(<App />));
    expect(await screen.findByText("PAGE /orders")).toBeInTheDocument();
    expect(screen.queryByText("novo")).not.toBeInTheDocument();
  });

  it("a varredura automática de outro ambiente não aparece como spec deste", async () => {
    window.location.hash = "#/specs";
    stubApi({
      ...FULL,
      "/api/v1/projects/p1/specs": () =>
        json([
          { id: "s9", version: 9, title: "Varredura automática · lab", source_type: "auto", environment_id: "e-other" },
          { id: "s2", version: 2, title: "Regras v2", source_type: "text" },
          { id: "s3", version: 3, title: "Varredura automática · hml", source_type: "auto", environment_id: "e1" },
        ]),
    });
    render(wrap(<App />));
    const list = await screen.findByRole("complementary", { name: "Especificações do projeto" });
    expect(await within(list).findByText("Regras v2")).toBeInTheDocument();
    expect(within(list).getByText("Varredura automática · hml")).toBeInTheDocument();
    expect(within(list).queryByText("Varredura automática · lab")).not.toBeInTheDocument();
  });

  it("a visão geral lista o que merece atenção e o que falta preparar, com atalho para o relatório", async () => {
    window.location.hash = "#/";
    const notReady = { ...BRIEF, facts: { ...BRIEF.facts, readiness: [{ id: "runner", label: "Runner conectado", ok: false, detail: "Nenhum runner respondeu nos últimos 2 minutos." }] } };
    stubApi({ ...FULL, "/api/v1/environments/e1/brief": () => json(notReady) });
    render(wrap(<App />));
    const card = await screen.findByRole("region", { name: "Pontos de atenção" });
    expect(await within(card).findByText("Runner conectado")).toBeInTheDocument();
    expect(within(card).getByText("preparar")).toBeInTheDocument();
    expect(within(card).getByText(/1 requisito não está ligado a nenhuma tela/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Abrir relatório" }));
    expect(await screen.findByRole("dialog", { name: "Relatório geral" })).toBeInTheDocument();
  });

  it("uma regressão não mostra a tabela de usuários explorados (esse resumo é de exploração)", async () => {
    window.location.hash = "#/execucoes";
    const run = { id: "r5", type: "regression", trigger: "manual", status: "succeeded", summary: { by_role: { admin: { steps: 2, passed: 2, failed: 0, errors: 0, skipped: 0 } } }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([run]),
      "/api/v1/runs/r5/report": () => json({ run: { id: "r5", type: "regression", status: "succeeded", duration_seconds: 5 }, steps: {}, requirements: [], bugs: { new: [], recurring: [], fixed: [] }, cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 } }),
    });
    render(wrap(<App />));
    await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(screen.queryByRole("table", { name: "Usuários explorados" })).not.toBeInTheDocument();
  });

  it("o card de bug diz quem ele afeta", async () => {
    window.location.hash = "#/bugs";
    stubApi({ ...FULL, "/api/v1/projects/p1/bugs": () => json([{ id: "b1", title: "/orders: HTTP 500", status: "new", severity: "critical", users: ["admin", "operador"] }]) });
    render(wrap(<App />));
    const afeta = await screen.findByText(/Afeta:/);
    expect(within(afeta.closest("p") as HTMLElement).getByText("admin")).toBeInTheDocument();
    expect(within(afeta.closest("p") as HTMLElement).getByText("operador")).toBeInTheDocument();
  });

  it("no mapa só os primeiros bugs ficam à vista, com atalho para a lista", async () => {
    window.location.hash = "#/mapa";
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: `/p${i}: HTTP 500`, status: "new", severity: "normal" }));
    stubApi({ ...FULL, "/api/v1/projects/p1/bugs": () => json(many) });
    render(wrap(<App />));
    const bugs = await screen.findByRole("region", { name: "Bugs" });
    expect(within(bugs).getAllByRole("button", { name: "Reproduzir" })).toHaveLength(3);
    await userEvent.click(within(bugs).getByRole("button", { name: /Ver todos os 6 bugs/ }));
    expect(window.location.hash).toBe("#/bugs");
  });
});

describe("relatório geral", () => {
  let saved: { name: string; type: string }[];
  beforeEach(() => {
    window.location.hash = "#/bugs"; // any page
    saved = [];
    URL.createObjectURL = vi.fn((blob: Blob) => (saved.push({ name: "", type: blob.type }), "blob:report"));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved[saved.length - 1] = { name: this.download, type: saved[saved.length - 1]?.type ?? "" };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("abre de qualquer página, mostra os pontos de atenção e a prontidão", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/brief": () => json(BRIEF) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    expect(await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.")).toBeInTheDocument();
    expect(within(dialog).getByText("texto padrão")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 requisito não está ligado a nenhuma tela/)).toBeInTheDocument();
    expect(within(dialog).getByText("Runner conectado")).toBeInTheDocument();
    expect(within(dialog).getByText("Escopo e método")).toBeInTheDocument();
  });

  it("baixa o relatório em HTML, Markdown e JSON, com nome do ambiente e do dia", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/brief": () => json(BRIEF) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.");
    await userEvent.click(within(dialog).getByRole("button", { name: /Baixar HTML/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Markdown" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    expect(saved).toEqual([
      { name: "relatorio-portal-hml-2026-10-05.html", type: "text/html;charset=utf-8" },
      { name: "relatorio-portal-hml-2026-10-05.md", type: "text/markdown;charset=utf-8" },
      { name: "relatorio-portal-hml-2026-10-05.json", type: "application/json;charset=utf-8" },
    ]);
  });

  it("pede à IA o texto no mesmo formato e troca só o texto, mantendo os fatos", async () => {
    let asked = 0;
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/brief": () => json(BRIEF),
      "/api/v1/environments/e1/brief/narrative": () => (asked++, json({ facts: BRIEF.facts, narrative: { ...BRIEF.narrative, source: "ai", executive_summary: "Resumo claro escrito pela IA." } })),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.");
    await userEvent.click(within(dialog).getByRole("button", { name: /Resumir com IA/ }));
    expect(await within(dialog).findByText("Resumo claro escrito pela IA.")).toBeInTheDocument();
    expect(within(dialog).getByText("escrito por IA")).toBeInTheDocument();
    expect(asked).toBe(1);
    expect(within(dialog).getByText(/1 requisito não está ligado/)).toBeInTheDocument(); // the facts did not change
  });

  it("não deixa pedir IA quando o servidor não tem modelo, e explica; o relatório padrão continua", async () => {
    const noLlm = { ...BRIEF, facts: { ...BRIEF.facts, readiness: [{ id: "llm", label: "Modelo de IA configurado", ok: false, detail: "Sem modelo de IA." }] } };
    stubApi({ ...FULL, "/api/v1/environments/e1/brief": () => json(noLlm) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.");
    expect(within(dialog).getByRole("button", { name: /Resumir com IA/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /Baixar HTML/ })).toBeEnabled();
  });

  it("se a IA falha, avisa e mantém o texto padrão", async () => {
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/brief": () => json(BRIEF),
      "/api/v1/environments/e1/brief/narrative": () => json({ error: "the model returned a report that breaks the format" }, 502),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.");
    await userEvent.click(within(dialog).getByRole("button", { name: /Resumir com IA/ }));
    expect(await screen.findByText("Não foi possível gerar com IA")).toBeInTheDocument();
    expect(within(dialog).getByText("No ambiente hml foram mapeadas 2 telas.")).toBeInTheDocument();
  });

  it("imprime numa janela própria", async () => {
    const doc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const win = { document: doc, focus: vi.fn(), print: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    stubApi({ ...FULL, "/api/v1/environments/e1/brief": () => json(BRIEF) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /^Relatório$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Relatório geral" });
    await within(dialog).findByText("No ambiente hml foram mapeadas 2 telas.");
    await userEvent.click(within(dialog).getByRole("button", { name: /Imprimir/ }));
    expect(doc.write).toHaveBeenCalledWith(expect.stringContaining("<!doctype html>"));
    await waitFor(() => expect(win.print).toHaveBeenCalled());
  });
});

describe("fluxos", () => {
  beforeEach(() => {
    window.location.hash = "#/fluxos";
  });
  const withFlows = (extra: Record<string, (init?: RequestInit) => Response> = {}) => stubApi({ ...FULL, "/api/v1/environments/e1/graph": () => json(FLOW_GRAPH), ...extra });

  it("lista as jornadas que o agente encontrou, com os usuários e as telas de acesso diferente", async () => {
    withFlows();
    render(wrap(<App />));
    const list = await screen.findByRole("complementary", { name: "Lista de fluxos" });
    const item = await within(list).findByRole("button", { name: /\/clients/ });
    expect(within(item).getByText("3 telas")).toBeInTheDocument();
    expect(within(item).getByText("admin")).toBeInTheDocument();
    expect(within(item).getByText("operador")).toBeInTheDocument();
    expect(within(item).getByText("1 com acesso diferente")).toBeInTheDocument(); // /clients/:id is only the admin's
    // plain links are not a journey: "/" only links to /clients
    expect(within(list).queryByRole("button", { name: /^\/ / })).not.toBeInTheDocument();
  });

  it("mostra o fluxograma em raias: a mesma tela para cada usuário, e um fantasma onde falta acesso", async () => {
    withFlows();
    render(wrap(<App />));
    const chart = await screen.findByTestId("flow-chart");
    expect(within(chart).getByRole("button", { name: "admin: /clients" })).toHaveAttribute("data-ghost", "false");
    expect(within(chart).getByRole("button", { name: "operador: /clients" })).toHaveAttribute("data-ghost", "false");
    expect(within(chart).getByRole("button", { name: "operador: /clients/:id" })).toHaveAttribute("data-ghost", "true");
    const arrows = within(within(chart).getByRole("list", { name: "setas" }));
    expect(arrows.getByText("admin | abre “Novo cliente”")).toBeInTheDocument();
    expect(arrows.getByText("operador | abre “Novo cliente”")).toBeInTheDocument();
    expect(arrows.getByText("admin | envia “Novo cliente”")).toBeInTheDocument();
    expect(arrows.queryByText("operador | envia “Novo cliente”")).not.toBeInTheDocument();
  });

  it("colore cada tela pelo último teste daquele usuário", async () => {
    withFlows({ "/api/v1/environments/e1/node-status": () => json([{ node_id: "cl-a", run_id: "r2", status: "fail", passed: 0, failed: 1, errored: 0, skipped: 0, at: "" }, { node_id: "cl-o", run_id: "r2", status: "pass", passed: 1, failed: 0, errored: 0, skipped: 0, at: "" }]) });
    render(wrap(<App />));
    const chart = await screen.findByTestId("flow-chart");
    await waitFor(() => expect(within(chart).getByRole("button", { name: "admin: /clients" })).toHaveAttribute("data-tone", "failing"));
    expect(within(chart).getByRole("button", { name: "operador: /clients" })).toHaveAttribute("data-tone", "passed");
  });

  it("abre os detalhes de uma tela e, para quem não alcança, explica", async () => {
    withFlows({ "/api/v1/nodes/cl-a/history": () => json([]) });
    render(wrap(<App />));
    const chart = await screen.findByTestId("flow-chart");
    await userEvent.click(within(chart).getByRole("button", { name: "admin: /clients" }));
    const detail = await screen.findByRole("complementary", { name: "Detalhes da tela" });
    expect(within(detail).getByText(/Só admin tem:/)).toBeInTheDocument();
    expect(within(detail).getAllByText("Excluir cliente").length).toBeGreaterThan(0);
    await userEvent.click(within(chart).getByRole("button", { name: "operador: /clients/:id" }));
    expect(await screen.findByText(/operador não alcançou esta tela/)).toBeInTheDocument();
    expect(screen.getByText(/Quem alcança: admin/)).toBeInTheDocument();
  });

  it("mostra quais telas do fluxo nenhum requisito cobre, e deixa filtrar por elas", async () => {
    withFlows();
    render(wrap(<App />));
    const list = await screen.findByRole("complementary", { name: "Lista de fluxos" });
    const item = await within(list).findByRole("button", { name: /\/clients/ });
    expect(within(item).getByText("1 tela sem requisito")).toHaveAttribute("title", expect.stringContaining("/clients/:id"));
    await userEvent.click(within(list).getByRole("checkbox", { name: "Só com tela sem requisito" }));
    expect(within(list).getByRole("button", { name: /\/clients/ })).toBeInTheDocument();
  });

  it("o painel de uma tela diz por qual requisito ela é especificada, ou que nenhum a cobre", async () => {
    withFlows({ "/api/v1/nodes/cl-a/history": () => json([]), "/api/v1/nodes/show-a/history": () => json([]) });
    render(wrap(<App />));
    const chart = await screen.findByTestId("flow-chart");
    await userEvent.click(within(chart).getByRole("button", { name: "admin: /clients" }));
    const detail = await screen.findByRole("complementary", { name: "Detalhes da tela" });
    expect(within(detail).getByText("Especificada por:")).toBeInTheDocument();
    expect(within(detail).getByText("PAGE /clients")).toBeInTheDocument();
    await userEvent.click(within(chart).getByRole("button", { name: "admin: /clients/:id" }));
    expect(await screen.findByText(/Nenhum requisito cobre esta tela/)).toBeInTheDocument();
  });

  it("filtra por texto e por permissões diferentes", async () => {
    withFlows();
    render(wrap(<App />));
    const list = await screen.findByRole("complementary", { name: "Lista de fluxos" });
    await within(list).findByRole("button", { name: /\/clients/ });
    await userEvent.type(within(list).getByLabelText("Buscar fluxos"), "zzz");
    expect(within(list).getByText(/Nenhum fluxo encontrado/)).toBeInTheDocument();
    await userEvent.clear(within(list).getByLabelText("Buscar fluxos"));
    await userEvent.click(within(list).getByRole("checkbox", { name: "Só com permissões diferentes" }));
    expect(within(list).getByRole("button", { name: /\/clients/ })).toBeInTheDocument();
  });

  it("monta fluxos a partir dos requisitos de uma especificação", async () => {
    withFlows({
      "/api/v1/specs/s2/coverage?graph_id=g1": () =>
        json({ requirements: [{ key: "FORM POST /clients", text: "O formulário aceita dados válidos", criticality: "high", status: "covered", node_ids: ["cl-a", "cl-o"] }], nodes: [] }),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("radio", { name: "Requisitos" }));
    const list = screen.getByRole("complementary", { name: "Lista de fluxos" });
    expect(await within(list).findByRole("button", { name: /FORM POST \/clients/ })).toBeInTheDocument();
    expect(within(list).getByLabelText("Especificação")).toHaveValue("s2");
  });

  it("mostra o que uma regressão testou, com o resultado daquela execução", async () => {
    withFlows({
      "/api/v1/runs/r2/node-results": () =>
        json([
          { node_id: "cl-a", result: "fail" }, // the worst of its checks, decided by the server
          { node_id: "cl-o", result: "pass" },
        ]),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("radio", { name: "Execução" }));
    const chart = await screen.findByTestId("flow-chart");
    await waitFor(() => expect(within(chart).getByRole("button", { name: "admin: /clients" })).toHaveAttribute("data-tone", "failing")); // the worst of its checks
    expect(within(chart).getByRole("button", { name: "operador: /clients" })).toHaveAttribute("data-tone", "passed");
    expect(screen.getByRole("combobox", { name: "Execução" })).toHaveValue("r2");
  });

  it("avisa quando a execução é de uma versão antiga do mapa", async () => {
    withFlows({ "/api/v1/runs/r2/node-results": () => json([{ node_id: "old-node", result: "pass" }]) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("radio", { name: "Execução" }));
    expect(await screen.findByText(/versão antiga do mapa/)).toBeInTheDocument();
  });

  it("explica que as imagens vêm na próxima exploração quando nenhuma tela tem imagem", async () => {
    withFlows();
    render(wrap(<App />));
    await screen.findByTestId("flow-chart");
    expect(screen.queryByText(/As imagens das telas aparecem a partir da próxima exploração/)).not.toBeInTheDocument(); // cl-a has one
    const noPics = { ...FLOW_GRAPH, nodes: FLOW_GRAPH.nodes.map((n) => ({ ...n, has_thumbnail: false })) };
    vi.unstubAllGlobals();
    stubApi({ ...FULL, "/api/v1/environments/e1/graph": () => json(noPics) });
    render(wrap(<App />));
    expect((await screen.findAllByText(/As imagens das telas aparecem a partir da próxima exploração/)).length).toBeGreaterThan(0);
  });

  it("convida a explorar quando ainda não há mapa", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/graph": () => json({ error: "no graph" }, 404) });
    render(wrap(<App />));
    expect(await screen.findByText("Ainda não há mapa para mostrar")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /Nova exploração/ })[1] as HTMLElement); // the one in the page, not the top bar
    expect(await screen.findByRole("dialog", { name: "Nova exploração" })).toBeInTheDocument();
  });

  it("tem um item no menu lateral", async () => {
    withFlows();
    render(wrap(<App />));
    const nav = await screen.findByRole("navigation", { name: "Navegação" });
    const link = within(nav).getByRole("link", { name: "Fluxos" });
    expect(link).toHaveAttribute("href", "#/fluxos");
    expect(link).toHaveAttribute("aria-current", "page");
  });
});

describe("mapa por usuário", () => {
  const TWO_USERS = {
    graph: { id: "g1", version: 1 },
    nodes: [
      { id: "n1", kind: "page", label: "/orders", app_roles: ["admin"], metadata: {}, requirement_count: 1 },
      { id: "n2", kind: "page", label: "/admin", app_roles: ["admin"], metadata: {}, requirement_count: 1 },
      { id: "n3", kind: "page", label: "/orders", app_roles: ["operador"], metadata: {}, requirement_count: 1 },
    ],
    edges: [],
  };
  beforeEach(() => {
    window.location.hash = "#/mapa";
  });

  it("filtra o mapa pelo usuário escolhido", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/graph": () => json(TWO_USERS) });
    render(wrap(<App />));
    const graph = await screen.findByTestId("graph");
    await waitFor(() => expect(graph.getAttribute("data-labels")).toBe("/orders,/admin,/orders"));
    await userEvent.selectOptions(screen.getByLabelText("Ver o mapa como"), "operador");
    expect(screen.getByTestId("graph").getAttribute("data-labels")).toBe("/orders");
  });

  it("mostra quem enxerga o quê e destaca os fluxos alternativos", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/graph": () => json(TWO_USERS) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("radio", { name: "Acesso por usuário" }));
    const matrix = await screen.findByLabelText("Acesso por usuário", { selector: "div" });
    expect(within(matrix).getByText(/1 tela é alcançada só por alguns usuários/)).toBeInTheDocument();
    expect(within(matrix).getByLabelText("operador não alcança /admin")).toBeInTheDocument();
    // the last test said /orders failed for the admin (n1): the cell is marked with it
    expect(within(matrix).getByRole("button", { name: "admin em /orders: falhou" })).toBeInTheDocument();
    expect(within(matrix).getByRole("button", { name: "operador em /orders: coberto, não testado" })).toBeInTheDocument();
  });
});

describe("especificações", () => {
  beforeEach(() => {
    window.location.hash = "#/specs";
  });

  it("lista as versões e os requisitos da mais recente, com a cobertura de cada um", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    const reqs = await screen.findByRole("region", { name: "Requisitos" });
    expect(await within(reqs).findByText("Listar pedidos")).toBeInTheDocument();
    expect(within(reqs).getByText("Coberto")).toBeInTheDocument();
    expect(within(reqs).getByText("Sem tela")).toBeInTheDocument();
    expect(within(reqs).getByText("crítico")).toBeInTheDocument();
    const versions = screen.getByRole("complementary", { name: "Especificações do projeto" });
    expect(within(versions).getByText("Regras v2")).toBeInTheDocument();
    expect(within(versions).getByText("Regras v1")).toBeInTheDocument();
  });

  it("separa requisitos de negócio e verificações automáticas", async () => {
    stubApi({
      ...FULL,
      "/api/v1/specs/s2/requirements": () =>
        json([
          { id: "q1", key: "REQ-001", text: "Listar pedidos", criticality: "critical", status: "unchanged", category: "business" },
          { id: "q2", key: "PAGE /orders", text: "A tela /orders responde sem erro", criticality: "normal", status: "unchanged", category: "technical" },
        ]),
    });
    render(wrap(<App />));
    const reqs = await screen.findByRole("region", { name: "Requisitos" });
    expect(await within(reqs).findByText("Listar pedidos")).toBeInTheDocument();
    expect(within(reqs).queryByText("A tela /orders responde sem erro")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /Verificações automáticas/ }));
    expect(await within(reqs).findByText("A tela /orders responde sem erro")).toBeInTheDocument();
    expect(within(reqs).queryByText("Listar pedidos")).not.toBeInTheDocument();
  });

  it("mostra os requisitos de uma versão antiga, sem cobertura", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Regras v1/ }));
    expect(await screen.findByText("Listar pedidos (antigo)")).toBeInTheDocument();
    expect(screen.queryByText("Coberto")).not.toBeInTheDocument();
  });

  it("filtra por criticidade e por texto", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    await screen.findByText("Emitir relatório mensal");
    await userEvent.click(screen.getByRole("radio", { name: "Críticos" }));
    expect(screen.queryByText("Emitir relatório mensal")).not.toBeInTheDocument();
    expect(screen.getByText("Listar pedidos")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Todos" }));
    await userEvent.type(screen.getByLabelText("Buscar requisitos"), "mensal");
    expect(screen.queryByText("Listar pedidos")).not.toBeInTheDocument();
    expect(screen.getByText("Emitir relatório mensal")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Buscar requisitos"));
    await userEvent.type(screen.getByLabelText("Buscar requisitos"), "zzz");
    expect(screen.getByText("Nenhum requisito encontrado")).toBeInTheDocument();
  });

  it("convida a enviar a primeira spec e abre o diálogo", async () => {
    stubApi({ ...FULL, "/api/v1/projects/p1/specs": () => json([]) });
    render(wrap(<App />));
    expect(await screen.findByText("Nenhuma especificação ainda")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /Nova especificação/ })[0] as HTMLElement);
    expect(await screen.findByRole("dialog", { name: "Nova especificação" })).toBeInTheDocument();
  });
});

describe("especificações: gerenciar e rodar uma só", () => {
  beforeEach(() => {
    window.location.hash = "#/specs";
  });

  it("roda só a spec escolhida", async () => {
    let body = "";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "regression", status: "queued", summary: {} }, 201)) : json([])) });
    render(wrap(<App />));
    const run = await screen.findByRole("button", { name: /Rodar esta spec/ });
    await waitFor(() => expect(run).toBeEnabled());
    await userEvent.click(run);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova regressão" })).getByRole("button", { name: /Iniciar regressão/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ type: "regression", spec_id: "s2" }));
  });

  it("cruza só a spec escolhida", async () => {
    let body = "";
    stubApi({ ...FULL, "/api/v1/environments/e1/crossref": (init) => ((body = String(init?.body)), json({ links: 1, pendencies_created: 0 })) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Cruzar com o mapa/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ spec_id: "s2" }));
  });

  it("gera a spec automática a partir do mapa", async () => {
    const calls = stubApi({ ...FULL, "/api/v1/environments/e1/specs/auto": () => json({ spec_id: "s3", version: 3, created: 5, updated: 0, unchanged: 0, removed: 0 }, 201) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Gerar spec automática/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/specs/auto", method: "POST" }));
    expect(await screen.findByText("Especificação automática atualizada")).toBeInTheDocument();
    expect(screen.getByText(/5 nova\(s\)/)).toBeInTheDocument();
  });

  it("a spec automática aparece à parte e não vira a spec do cruzamento com a IA", async () => {
    const withAuto = [{ id: "s3", version: 3, title: "Varredura automática", source_type: "auto" }, { id: "s2", version: 2, title: "Regras v2", source_type: "text" }];
    stubApi({
      ...FULL,
      "/api/v1/projects/p1/specs": () => json(withAuto),
      "/api/v1/specs/s3/requirements": () => json([{ id: "q9", key: "PAGE /orders", text: "A tela /orders responde sem erro", criticality: "normal", status: "new" }]),
    });
    render(wrap(<App />));
    const list = await screen.findByRole("complementary", { name: "Especificações do projeto" });
    expect(await within(list).findByText("Regras v2")).toBeInTheDocument();
    expect(within(list).getByText("Varredura automática")).toBeInTheDocument();
    expect(within(list).getByText("Automática")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Atualizar varredura automática/ })).toBeInTheDocument();
    // the topbar crossref uses the written spec, so it stays enabled
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Cruzar com a spec/ })[0]).toBeEnabled());
    await userEvent.click(within(list).getByRole("button", { name: /Varredura automática/ }));
    expect(await screen.findByText("PAGE /orders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cruzar com o mapa/ })).not.toBeInTheDocument(); // no LLM crossref for the sweep
  });

  it("edita um requisito", async () => {
    let body = "";
    const calls = stubApi({ ...FULL, "/api/v1/requirements/q2": (init) => ((body = String(init?.body)), json({ id: "q2", key: "REQ-002", text: "x", criticality: "high" })) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: "Editar REQ-002" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar REQ-002" });
    await userEvent.clear(within(dialog).getByLabelText("Texto"));
    await userEvent.type(within(dialog).getByLabelText("Texto"), "Emitir relatório trimestral");
    await userEvent.selectOptions(within(dialog).getByLabelText("Criticidade"), "high");
    await userEvent.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/requirements/q2", method: "PATCH" }));
    expect(JSON.parse(body)).toEqual({ text: "Emitir relatório trimestral", criticality: "high" });
  });

  it("adiciona um requisito à spec", async () => {
    let body = "";
    const calls = stubApi({ ...FULL, "/api/v1/specs/s2/requirements": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "q3", key: "REQ-003" }, 201)) : FULL["/api/v1/specs/s2/requirements"]()) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Requisito/ }));
    const dialog = await screen.findByRole("dialog", { name: "Novo requisito" });
    await userEvent.type(within(dialog).getByLabelText("Texto"), "Exportar pedidos em CSV");
    await userEvent.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/specs/s2/requirements", method: "POST" }));
    expect(JSON.parse(body)).toEqual({ text: "Exportar pedidos em CSV", criticality: "normal" });
  });

  it("sinaliza requisitos que serão difíceis de testar, com a razão", async () => {
    stubApi({
      ...FULL,
      "/api/v1/specs/s2/requirements": () =>
        json([
          { id: "q1", key: "REQ-001", text: "O sistema deve ser rápido.", criticality: "normal", status: "new", quality: ["vago"] },
          { id: "q2", key: "REQ-002", text: "A advogada vê a lista de clientes ao entrar no sistema agora.", criticality: "normal", status: "new", quality: ["parecido com REQ-001"] },
          { id: "q3", key: "REQ-003", text: "A advogada cria um cliente com nome e e-mail e vê a ficha dele.", criticality: "normal", status: "new", quality: [] },
        ]),
    });
    render(wrap(<App />));
    const vague = await screen.findByLabelText("Revisar REQ-001");
    expect(within(vague).getByText("revisar: vago")).toHaveAttribute("title", expect.stringContaining("nenhum teste decide"));
    expect(within(screen.getByLabelText("Revisar REQ-002")).getByText("revisar: parecido com REQ-001")).toBeInTheDocument();
    expect(screen.queryByLabelText("Revisar REQ-003")).not.toBeInTheDocument();
  });

  it("exclui um requisito depois de confirmar", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const calls = stubApi({ ...FULL, "/api/v1/requirements/q1": () => new Response(null, { status: 204 }) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: "Excluir REQ-001" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/requirements/q1", method: "DELETE" }));
  });

  it("não exclui o requisito se a pessoa desistir", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const calls = stubApi(FULL);
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: "Excluir REQ-001" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("renomeia e exclui a especificação", async () => {
    let body = "";
    const calls = stubApi({
      ...FULL,
      "/api/v1/specs/s2": (init) => (init?.method === "PATCH" ? ((body = String(init.body)), json({ id: "s2", version: 2, title: "Novo nome" })) : new Response(null, { status: 204 })),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Renomear/ }));
    const dialog = await screen.findByRole("dialog", { name: "Renomear especificação" });
    await userEvent.clear(within(dialog).getByLabelText("Nome"));
    await userEvent.type(within(dialog).getByLabelText("Nome"), "Novo nome");
    await userEvent.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/specs/s2", method: "PATCH" }));
    expect(JSON.parse(body)).toEqual({ title: "Novo nome" });

    await userEvent.click(await screen.findByRole("button", { name: /^Excluir$/ }));
    const confirm = await screen.findByRole("dialog", { name: "Excluir especificação" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Excluir especificação" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/specs/s2", method: "DELETE" }));
  });

  it("mostra o último resultado de cada requisito da spec", async () => {
    const run = { id: "r5", type: "regression", trigger: "manual", status: "succeeded", summary: {}, budget: { spec_id: "s2" }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([run, ...RUNS]),
      "/api/v1/runs/r5/report": () =>
        json({
          run: { id: "r5", type: "regression", status: "succeeded", duration_seconds: 5 },
          steps: { pass: 1, fail: 1 },
          requirements: [
            { key: "REQ-001", outcome: "pass", criticality: "critical" },
            { key: "REQ-002", outcome: "fail", criticality: "normal" },
          ],
          bugs: { new: [], recurring: [], fixed: [] },
          cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        }),
    });
    render(wrap(<App />));
    const reqs = await screen.findByRole("region", { name: "Requisitos" });
    expect(await within(reqs).findByText("Passou")).toBeInTheDocument();
    expect(within(reqs).getByText("Falhou")).toBeInTheDocument();
  });
});

describe("executar como um usuário", () => {
  const creds = () => json([{ id: "c1", app_role: "admin", kind: "login" }, { id: "c2", app_role: "operador", kind: "login" }, { id: "c3", app_role: "token", kind: "api_token" }]);

  it("deixa escolher quais usuários a regressão testa", async () => {
    let body = "";
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/credentials": creds,
      "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "regression", status: "queued", summary: {} }, 201)) : json([])),
    });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova regressão/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova regressão" });
    // only logins are users (an API token is not someone who signs in), all start selected
    expect(within(dialog).getByRole("checkbox", { name: "admin" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "operador" })).toBeChecked();
    expect(within(dialog).queryByRole("checkbox", { name: "token" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "admin" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar regressão/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ type: "regression", budget: { roles: ["operador"] } }));
  });

  it("a regressão pode usar mais navegadores por usuário, e o padrão é um", async () => {
    let body = "";
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "regression", status: "queued", summary: {} }, 201)) : json([])),
    });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova regressão/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova regressão" });
    expect(within(dialog).getByLabelText("Navegadores em paralelo")).toHaveValue("1");
    await userEvent.selectOptions(within(dialog).getByLabelText("Navegadores em paralelo"), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar regressão/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ type: "regression", budget: { concurrency: 4 } }));
  });

  it("com todos os usuários marcados não restringe nada, e sem nenhum não deixa iniciar", async () => {
    let body = "";
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/credentials": creds,
      "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "regression", status: "queued", summary: {} }, 201)) : json([])),
    });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova regressão/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova regressão" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "admin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "operador" }));
    expect(within(dialog).getByRole("button", { name: /Iniciar regressão/ })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "admin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "operador" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar regressão/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ type: "regression" }));
  });

  it("a exploração tem tamanhos prontos e limites ajustáveis para apps grandes", async () => {
    let body = "";
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "exploration", status: "queued", summary: {} }, 201)) : json([])),
    });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "App grande" }));
    expect(within(dialog).getByLabelText("Telas")).toHaveValue(1000);
    await userEvent.clear(within(dialog).getByLabelText("Telas"));
    await userEvent.type(within(dialog).getByLabelText("Telas"), "1500");
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() =>
      expect(JSON.parse(body)).toEqual({ type: "exploration", budget: { max_pages: 1500, max_depth: 8, max_actions: 1200, max_seconds: 7200, max_llm_calls: 150 } }),
    );
  });

  it("a exploração padrão não manda orçamento, para valer o do servidor", async () => {
    let body = "";
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((body = String(init.body)), json({ id: "r9", type: "exploration", status: "queued", summary: {} }, 201)) : json([])),
    });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova exploração" })).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() => expect(JSON.parse(body)).toEqual({ type: "exploration" }));
  });
});

describe("explorar só alguns usuários e continuar uma exploração", () => {
  const creds = () => json([{ id: "c1", app_role: "admin", kind: "login" }, { id: "c2", app_role: "operador", kind: "login" }]);
  const interrupted = { id: "r7", type: "exploration", trigger: "manual", status: "cancelled", summary: {}, created_at: ago(3_600_000), started_at: ago(3_590_000), finished_at: ago(3_500_000) };
  const post = (store: { body: string }, runs: unknown[] = []) => (init?: RequestInit) =>
    init?.method === "POST" ? ((store.body = String(init.body)), json({ id: "r9", type: "exploration", status: "queued", summary: {} }, 201)) : json(runs);

  it("a exploração deixa escolher os usuários e avisa que o mapa dos outros continua", async () => {
    const sent = { body: "" };
    stubApi({ ...FULL, "/api/v1/environments/e1/credentials": creds, "/api/v1/environments/e1/runs": post(sent) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    expect(within(dialog).getByRole("checkbox", { name: "admin" })).toBeChecked();
    expect(within(dialog).queryByText(/continuam como estão/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "admin" }));
    expect(within(dialog).getByText(/continuam como estão/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() => expect(JSON.parse(sent.body)).toEqual({ type: "exploration", budget: { roles: ["operador"] } }));
  });

  it("não deixa explorar sem nenhum usuário marcado", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/credentials": creds, "/api/v1/environments/e1/runs": post({ body: "" }) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "admin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "operador" }));
    expect(within(dialog).getByRole("button", { name: /Iniciar exploração/ })).toBeDisabled();
  });

  it("oferece continuar quando a última exploração parou antes do fim, e manda resume", async () => {
    const sent = { body: "" };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": post(sent, [interrupted]) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    const resume = within(dialog).getByRole("checkbox", { name: /Continuar de onde parou/ });
    expect(resume).not.toBeChecked();
    expect(within(dialog).getByText(/foi cancelada/)).toBeInTheDocument();
    await userEvent.click(resume);
    await userEvent.click(within(dialog).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() => expect(JSON.parse(sent.body)).toEqual({ type: "exploration", budget: { resume: true } }));
  });

  it("não oferece continuar quando a última exploração terminou", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": post({ body: "" }, [{ ...interrupted, status: "succeeded", summary: { stopped_by: "exhausted" } }]) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    expect(within(dialog).queryByRole("checkbox", { name: /Continuar de onde parou/ })).not.toBeInTheDocument();
  });

  it("a página de execuções tem o botão Continuar na exploração interrompida, que abre o diálogo já marcado", async () => {
    window.location.hash = "#/execucoes";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": post({ body: "" }, [interrupted]) });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    await userEvent.click(within(detail).getByRole("button", { name: /Continuar exploração/ }));
    const dialog = await screen.findByRole("dialog", { name: "Nova exploração" });
    expect(within(dialog).getByRole("checkbox", { name: /Continuar de onde parou/ })).toBeChecked();
  });

  it("a execução diz como quem foi explorada quando não foram todos", async () => {
    window.location.hash = "#/execucoes";
    const partial = { ...interrupted, status: "succeeded", summary: { pages: 4, stopped_by: "exhausted" }, budget: { roles: ["operador"], resume: true } };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": post({ body: "" }, [partial]) });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(within(detail).getByText("Explorado como")).toBeInTheDocument();
    expect(within(detail).getByText("operador")).toBeInTheDocument();
    expect(within(detail).getByText(/Continuação/)).toBeInTheDocument();
  });
});

describe("segurança dentro da exploração e da regressão", () => {
  const SEC_BUGS = [
    { id: "b1", title: "REQ-001 · /orders: HTTP 500", status: "new", severity: "critical", category: "functional" },
    { id: "s1", title: "Segurança · Possível SQL injection: /item (id) devolve erro do banco ao receber aspas", status: "new", severity: "critical", category: "security", check: "sqli-error", users: ["admin"] },
    { id: "s2", title: "Segurança · Content-Security-Policy ausente nas respostas da aplicação", status: "confirmed", severity: "normal", category: "security", check: "header-csp" },
    { id: "s3", title: "Segurança · Cookie de sessão sem HttpOnly", status: "fixed", severity: "high", category: "security", check: "cookie-httponly" },
  ];

  it("a página de bugs separa os de segurança dos funcionais, e marca cada um", async () => {
    window.location.hash = "#/bugs";
    stubApi({ ...FULL, "/api/v1/projects/p1/bugs": () => json(SEC_BUGS) });
    render(wrap(<App />));
    expect(await screen.findByRole("region", { name: /Bug REQ-001/ })).toBeInTheDocument();
    const sql = screen.getByRole("region", { name: /Bug Segurança · Possível SQL injection/ });
    expect(within(sql).getByText("Segurança")).toBeInTheDocument(); // the tag; the title does not repeat it
    expect(within(sql).getByText("Possível SQL injection: /item (id) devolve erro do banco ao receber aspas")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /Bug REQ-001/ })).queryByText("Segurança")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /Segurança/ }));
    expect(screen.queryByRole("region", { name: /Bug REQ-001/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Bug Segurança · Possível SQL injection/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Bug Segurança · Content-Security-Policy/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Bug Segurança · Cookie de sessão/ })).not.toBeInTheDocument(); // fixed: not among the open ones

    await userEvent.click(screen.getByRole("radio", { name: /Funcionais/ }));
    expect(screen.getByRole("region", { name: /Bug REQ-001/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Bug Segurança · Possível SQL injection/ })).not.toBeInTheDocument();
  });

  it("a visão geral diz quantas falhas de segurança estão abertas, sem misturar nos bugs", async () => {
    window.location.hash = "#/";
    stubApi({ ...FULL, "/api/v1/projects/p1/bugs": () => json(SEC_BUGS) });
    render(wrap(<App />));
    const sec = await screen.findByRole("region", { name: "Segurança aberta" });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Segurança aberta" })).getByText("2")).toBeInTheDocument());
    expect(within(sec).getByText("1 crítica")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Bugs abertos" })).getByText("1")).toBeInTheDocument(); // the functional one only
  });

  it("as duas execuções verificam a segurança por padrão, e a pessoa pode desligar", async () => {
    const sent = { body: "" };
    const post = (init?: RequestInit) => (init?.method === "POST" ? ((sent.body = String(init.body)), json({ id: "r9", type: "exploration", status: "queued", summary: {} }, 201)) : json([]));
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": post });
    render(wrap(<App />));
    for (const [open, name, button] of [
      ["Nova exploração", "Nova exploração", /Iniciar exploração/],
      ["Nova regressão", "Nova regressão", /Iniciar regressão/],
    ] as const) {
      const b = await screen.findByRole("button", { name: new RegExp(open) });
      await waitFor(() => expect(b).toBeEnabled());
      await userEvent.click(b);
      const dialog = await screen.findByRole("dialog", { name });
      const check = within(dialog).getByRole("checkbox", { name: /Verificar segurança/ });
      expect(check).toBeChecked();
      await userEvent.click(check);
      await userEvent.click(within(dialog).getByRole("button", { name: button }));
      await waitFor(() => expect(JSON.parse(sent.body).budget).toMatchObject({ no_security: true }));
      sent.body = "";
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
  });

  it("deixando ligado, não manda nada: o servidor já verifica", async () => {
    const sent = { body: "" };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? ((sent.body = String(init.body)), json({ id: "r9", type: "exploration", status: "queued", summary: {} }, 201)) : json([])) });
    render(wrap(<App />));
    const b = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(b).toBeEnabled());
    await userEvent.click(b);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova exploração" })).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() => expect(JSON.parse(sent.body)).toEqual({ type: "exploration" }));
  });

  const secRun = { id: "r5", type: "exploration", trigger: "manual", status: "succeeded", summary: { pages: 4, stopped_by: "exhausted" }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
  const secReport = (security: unknown) => () =>
    json({ run: { id: "r5", type: "exploration", status: "succeeded", duration_seconds: 5 }, steps: {}, requirements: [], security, bugs: { new: [], recurring: [], fixed: [] }, cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 } });

  it("a execução mostra o que as verificações de segurança acharam, com a gravidade, e lista os achados", async () => {
    window.location.hash = "#/execucoes";
    const finding = { id: "x1", node_id: "n1", executor: "browser", input: { check: "xss-reflected", scope: "/search?q", user: "admin" }, expected: "O que chega pelo endereço é escapado ao ser exibido", actual: "XSS refletido: o parâmetro q de /search volta na página sem escape", result: "fail", security: { check: "xss-reflected", severity: "high", scope: "/search?q" }, user: "admin", artifacts: [] };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([secRun]),
      "/api/v1/runs/r5/report": secReport({ checks: 30, passed: 25, failed: 5, by_severity: { critical: 1, high: 2, normal: 2 } }),
      "/api/v1/runs/r5/steps?kind=security&limit=50": () => page([finding], 1),
    });
    render(wrap(<App />));
    const sec = await screen.findByRole("region", { name: "Segurança da execução" });
    expect(within(sec).getByText(/30 verificações/)).toBeInTheDocument();
    expect(within(sec).getByText(/5 com falha/)).toBeInTheDocument();
    expect(within(sec).getByText("1 crítica")).toBeInTheDocument();
    expect(within(sec).getByText("2 altas")).toBeInTheDocument();
    expect(within(sec).getByText("2 normais")).toBeInTheDocument();
    await userEvent.click(within(sec).getByText("Ver as verificações"));
    const list = await within(sec).findByRole("list", { name: "Verificações de segurança" });
    expect(within(list).getByText("alta")).toBeInTheDocument();
    expect(within(list).getByText(/XSS refletido: o parâmetro q/)).toBeInTheDocument();
    expect(within(list).getByText("como admin")).toBeInTheDocument();
  });

  it("não mostra a seção de segurança numa execução que não verificou nada", async () => {
    window.location.hash = "#/execucoes";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([secRun]), "/api/v1/runs/r5/report": secReport({ checks: 0, passed: 0, failed: 0, by_severity: { critical: 0, high: 0, normal: 0 } }) });
    render(wrap(<App />));
    await screen.findByRole("region", { name: "Detalhes da execução" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Segurança da execução" })).not.toBeInTheDocument());
  });

  it("as checagens comuns da execução não trazem as de segurança (o servidor já as separa)", async () => {
    window.location.hash = "#/execucoes";
    const asked: string[] = [];
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([secRun]),
      "/api/v1/runs/r5/report": secReport({ checks: 3, passed: 3, failed: 0, by_severity: { critical: 0, high: 0, normal: 0 } }),
      "/api/v1/runs/r5/steps?limit=50": () => (asked.push("functional"), page([], 0)),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByText("Checagens e evidências"));
    await waitFor(() => expect(asked).toEqual(["functional"]));
  });
});

describe("aplicação fora do ar e login barrado: um aviso só, e nada de bug", () => {
  const loginRun = {
    id: "r8", type: "exploration", trigger: "manual", status: "failed", created_at: ago(2000), started_at: ago(1900), finished_at: ago(1800),
    summary: {
      error: "Não foi possível entrar como admin: o login não foi aceito. Corrija o login em Configurações → Credenciais e rode de novo.",
      blocked: {
        kind: "login_failed", roles: ["admin"], message: "Não foi possível entrar como admin: o login não foi aceito. Corrija o login em Configurações → Credenciais e rode de novo.",
        details: [{ role: "admin", reason: "rejected", message: "o login não foi aceito: a tela de login continua aberta. A tela diz: \"Senha inválida\"." }],
      },
    },
  };
  const downRun = { ...loginRun, id: "r9", summary: { error: "A aplicação não respondeu em http://a: conexão recusada (ECONNREFUSED).", blocked: { kind: "app_down", message: "A aplicação não respondeu em http://a: conexão recusada (ECONNREFUSED). Ponha a aplicação no ar e rode de novo." } } };

  it("mostra em todas as páginas por que a última execução não pôde fazer o trabalho, com o caminho para corrigir", async () => {
    window.location.hash = "#/bugs";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([loginRun]) });
    render(wrap(<App />));
    const alert = await screen.findByRole("alert", { name: "Aviso do ambiente" });
    expect(within(alert).getByText("O login não funcionou")).toBeInTheDocument();
    expect(within(alert).getByText(/Não foi possível entrar como admin/)).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "Abrir credenciais" }));
    expect(window.location.hash).toBe("#/config/credenciais");
  });

  it("diz que a aplicação está fora do ar, sem mandar mexer nas credenciais", async () => {
    window.location.hash = "#/";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([downRun]) });
    render(wrap(<App />));
    const alert = await screen.findByRole("alert", { name: "Aviso do ambiente" });
    expect(within(alert).getByText("A aplicação está fora do ar")).toBeInTheDocument();
    expect(within(alert).queryByRole("button", { name: "Abrir credenciais" })).not.toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Ver a execução" })).toBeInTheDocument();
  });

  it("some quando uma execução depois dela funcionou", async () => {
    window.location.hash = "#/";
    const ok = { ...loginRun, id: "r10", status: "succeeded", summary: { pages: 5 }, created_at: ago(500), finished_at: ago(100) };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([ok, loginRun]) });
    render(wrap(<App />));
    await screen.findByRole("region", { name: "Bugs abertos" });
    expect(screen.queryByRole("alert", { name: "Aviso do ambiente" })).not.toBeInTheDocument();
  });

  it("a execução bloqueada se chama bloqueada, não falhou, e diz por usuário o que aconteceu", async () => {
    window.location.hash = "#/execucoes";
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([loginRun]) });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(within(detail).getByText("Bloqueada")).toBeInTheDocument();
    expect(within(detail).queryByText("Falhou")).not.toBeInTheDocument();
    const table = within(detail).getByRole("table", { name: "Usuários que não entraram" });
    expect(within(table).getByText("admin")).toBeInTheDocument();
    expect(within(table).getByText(/Senha inválida/)).toBeInTheDocument();
  });

  it("uma execução que mapeou os outros usuários avisa de quem não entrou, sem ser bloqueada", async () => {
    window.location.hash = "#/execucoes";
    const partial = { ...loginRun, id: "r11", status: "succeeded", summary: { pages: 4, stopped_by: "exhausted", by_role: { admin: { pages: 4, login_ok: true }, op: { pages: 0, login_ok: false } }, blocked: { kind: "login_failed", roles: ["op"], message: "Não foi possível entrar como op: o login não foi aceito.", details: [{ role: "op", reason: "rejected", message: "o login não foi aceito" }] } } };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([partial]) });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(within(detail).queryByText("Bloqueada")).not.toBeInTheDocument();
    expect(await within(detail).findByText(/Não foi possível entrar como op/)).toBeInTheDocument();
  });
});

describe("usuários na execução", () => {
  beforeEach(() => {
    window.location.hash = "#/execucoes";
  });

  it("diz quais usuários foram testados, com o resultado de cada um", async () => {
    const run = { id: "r5", type: "regression", trigger: "manual", status: "succeeded", summary: {}, budget: { roles: ["operador"] }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([run]),
      "/api/v1/runs/r5/report": () =>
        json({
          run: { id: "r5", type: "regression", status: "succeeded", duration_seconds: 5 },
          steps: { pass: 3, fail: 1 },
          users: [
            { user: "admin", passed: 2, failed: 0, errored: 0, skipped: 0 },
            { user: "operador", passed: 1, failed: 1, errored: 0, skipped: 0 },
          ],
          requirements: [],
          bugs: { new: [], recurring: [], fixed: [] },
          cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        }),
    });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(within(detail).getByText("Testado como")).toBeInTheDocument();
    expect(within(detail).getAllByText("operador").length).toBeGreaterThan(0);
    const table = await within(detail).findByRole("table", { name: "Usuários testados" });
    expect(within(table).getByText("admin")).toBeInTheDocument();
    const op = within(table).getByText("operador").closest("tr") as HTMLElement;
    expect(within(op).getAllByRole("cell").map((c) => c.textContent)).toEqual(["operador", "1", "1", "0"]);
  });

  it("numa exploração mostra quantas telas cada usuário alcançou e quem não conseguiu entrar", async () => {
    const run = { id: "r6", type: "exploration", trigger: "manual", status: "succeeded", summary: { pages: 4, by_role: { admin: { pages: 3, login_ok: true }, estagiario: { pages: 0, login_ok: false } } }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([run]), "/api/v1/runs/r6/report": () => json({ run: { id: "r6", type: "exploration", status: "succeeded", duration_seconds: 5 }, steps: {}, requirements: [], bugs: { new: [], recurring: [], fixed: [] }, cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 } }) });
    render(wrap(<App />));
    const table = await screen.findByRole("table", { name: "Usuários explorados" });
    expect(within(table).getByText("entrou")).toBeInTheDocument();
    expect(within(table).getByText("falhou")).toBeInTheDocument();
  });

  it("cada checagem diz como quem rodou, e dá para filtrar por usuário e ver só as falhas (o servidor filtra)", async () => {
    const admin = { id: "a", node_id: "n1", user: "admin", executor: "browser", input: { url: "http://a/orders" }, expected: "x", actual: "ok", result: "pass", artifacts: [] };
    const op = { id: "b", node_id: "n2", user: "operador", executor: "browser", input: { url: "http://a/orders" }, expected: "x", actual: "HTTP 403", result: "fail", artifacts: [] };
    const asked: string[] = [];
    stubApi({
      ...FULL,
      "/api/v1/runs/r2/report": () =>
        json({
          run: { id: "r2", type: "regression", status: "failed", duration_seconds: 90 },
          steps: { pass: 1, fail: 1 },
          users: [{ user: "admin", passed: 1, failed: 0, errored: 0, skipped: 0 }, { user: "operador", passed: 0, failed: 1, errored: 0, skipped: 0 }],
          requirements: [],
          bugs: { new: [], recurring: [], fixed: [] },
          cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        }),
      "/api/v1/runs/r2/steps?limit=50": () => (asked.push("all"), page([op, admin], 2)),
      "/api/v1/runs/r2/steps?user=operador&limit=50": () => (asked.push("operador"), page([op], 1)),
      "/api/v1/runs/r2/steps?result=fail%2Cerror&limit=50": () => (asked.push("problems"), page([op], 1)),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByText("Checagens e evidências"));
    const list = await screen.findByRole("list", { name: "Checagens da execução" });
    expect(within(list).getByText("como admin")).toBeInTheDocument();
    expect(within(list).getByText("como operador")).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText("Filtrar por usuário"), "operador");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Checagens da execução" })).queryByText("como admin")).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Filtrar por usuário"), "*");
    await userEvent.click(screen.getByRole("checkbox", { name: "Só falhas e erros" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Checagens da execução" })).queryByText("como admin")).not.toBeInTheDocument());
    expect(screen.getByText("HTTP 403")).toBeInTheDocument();
    expect(asked).toEqual(expect.arrayContaining(["all", "operador", "problems"]));
  });

  it("pede os passos de 50 em 50: uma regressão grande tem milhares", async () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, node_id: "n1", user: "admin", executor: "browser", input: { url: `http://a/p${from + i}` }, expected: "x", actual: `ok ${from + i}`, result: "pass", artifacts: [] }));
    stubApi({
      ...FULL,
      "/api/v1/runs/r2/steps?limit=50": () => page(many(0, 50), 120),
      "/api/v1/runs/r2/steps?offset=50&limit=50": () => page(many(50, 50), 120),
      "/api/v1/runs/r2/steps?offset=100&limit=50": () => page(many(100, 20), 120),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByText("Checagens e evidências"));
    const list = await screen.findByRole("list", { name: "Checagens da execução" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("50 de 120")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mostrar mais 50" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(100));
    await userEvent.click(screen.getByRole("button", { name: "Mostrar mais 20" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(120));
    expect(screen.queryByRole("button", { name: /Mostrar mais/ })).not.toBeInTheDocument();
  });

  it("mostra por usuário o resultado de um requisito que mais de um usuário cobre", async () => {
    window.location.hash = "#/specs";
    const run = { id: "r5", type: "regression", trigger: "manual", status: "succeeded", summary: {}, budget: { spec_id: "s2" }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([run]),
      "/api/v1/runs/r5/report": () =>
        json({
          run: { id: "r5", type: "regression", status: "succeeded", duration_seconds: 5 },
          steps: { pass: 1, fail: 1 },
          requirements: [{ key: "REQ-001", outcome: "fail", criticality: "critical", by_user: { admin: "pass", operador: "fail" } }],
          bugs: { new: [], recurring: [], fixed: [] },
          cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        }),
    });
    render(wrap(<App />));
    const reqs = await screen.findByRole("region", { name: "Requisitos" });
    const by = await within(reqs).findByLabelText("Resultado por usuário");
    expect(within(by).getByText("admin: passou")).toBeInTheDocument();
    expect(within(by).getByText("operador: falhou")).toBeInTheDocument();
  });
});

describe("evidência das execuções", () => {
  beforeEach(() => {
    window.location.hash = "#/execucoes";
  });

  it("mostra, para cada checagem, o que foi digitado, as requisições e o HTTP devolvido", async () => {
    const doc = {
      kind: "form",
      url: "http://a/clients/new",
      form: { method: "POST", action: "/clients" },
      policy: "allow",
      status: 200,
      final_url: "http://a/clients/7",
      inputs: [
        { field: "client[name]", label: "Nome", type: "text", value: "Cliente QA 123" },
        { field: "client[password]", label: "Senha", type: "password", value: "***" },
      ],
      requests: [{ method: "POST", path: "/clients", status: 302, resource: "document", fields: ["client[name]"] }],
      messages: ["Cliente criado"],
    };
    stubApi({
      ...FULL,
      "/api/v1/runs/r2/steps?limit=50": () =>
        page([
          { id: "st1", node_id: "n1", executor: "browser", input: { form: "FORM POST /clients" }, expected: "POST /clients aceita dados", actual: "POST /clients → 302 → /clients/7", result: "pass", artifacts: [{ id: "a1", kind: "http", content_type: "application/json", size: 300 }] },
          { id: "st2", node_id: "n2", executor: "browser", input: { form: "FORM DELETE /clients" }, expected: "x", actual: "o ambiente não permite escrever (política: block)", result: "skipped", artifacts: [] },
        ]),
      "/api/v1/artifacts/a1/content": () => new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }),
    });
    render(wrap(<App />));
    await userEvent.click(await screen.findByText("Checagens e evidências"));
    const list = await screen.findByRole("list", { name: "Checagens da execução" });
    expect(within(list).getByText("passou")).toBeInTheDocument();
    expect(within(list).getByText("pulado")).toBeInTheDocument();
    expect(within(list).getByText(/não permite escrever/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Ver entradas e respostas" }));
    const inputs = await within(list).findByRole("table", { name: "Valores digitados" });
    expect(within(inputs).getByText("Cliente QA 123")).toBeInTheDocument();
    expect(within(inputs).getByText("***")).toBeInTheDocument(); // secrets never reach the screen
    const requests = within(list).getByRole("list", { name: "Requisições feitas" });
    expect(within(requests).getByText("POST /clients")).toBeInTheDocument();
    expect(within(requests).getByText("302")).toBeInTheDocument();
    expect(within(list).getByText("Cliente criado")).toBeInTheDocument();
  });

  it("diz qual especificação a execução testou", async () => {
    const run = { id: "r5", type: "regression", trigger: "manual", status: "succeeded", summary: {}, budget: { spec_id: "s2" }, created_at: ago(1000), started_at: ago(900), finished_at: ago(100) };
    stubApi({
      ...FULL,
      "/api/v1/environments/e1/runs": () => json([run]),
      "/api/v1/runs/r5/report": () => json({ run: { id: "r5", type: "regression", status: "succeeded", duration_seconds: 5 }, steps: {}, requirements: [], bugs: { new: [], recurring: [], fixed: [] }, cost: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 } }),
    });
    render(wrap(<App />));
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(await within(detail).findByText("Regras v2")).toBeInTheDocument();
  });
});

describe("execuções", () => {
  beforeEach(() => {
    window.location.hash = "#/execucoes";
  });

  it("lista o histórico e detalha a execução escolhida", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    const list = await screen.findByRole("region", { name: "Lista de execuções" });
    expect(within(list).getAllByRole("row")).toHaveLength(3); // header + 2 runs
    expect(within(list).getByText("CI")).toBeInTheDocument();
    const detail = await screen.findByRole("region", { name: "Detalhes da execução" });
    expect(await within(detail).findByText("passaram")).toBeInTheDocument(); // newest run (the failed regression) first
    expect(within(detail).getByText("8")).toBeInTheDocument();
    await userEvent.click(within(list).getByText("Exploração"));
    expect(await within(detail).findByText("12")).toBeInTheDocument(); // pages mapped
  });

  it("permite cancelar uma execução ativa", async () => {
    const active = { id: "r3", type: "exploration", trigger: "manual", status: "running", summary: {}, created_at: ago(20_000), started_at: ago(10_000), finished_at: null };
    const calls = stubApi({ ...FULL, "/api/v1/environments/e1/runs": () => json([active, ...RUNS]), "/api/v1/runs/r3/cancel": () => json({ id: "r3", status: "cancelled" }) });
    render(wrap(<App />));
    await userEvent.click(await screen.findByRole("button", { name: /Cancelar/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/runs/r3/cancel", method: "POST" }));
  });
});

describe("bugs", () => {
  beforeEach(() => {
    window.location.hash = "#/bugs";
  });

  it("mostra só os abertos por padrão e deixa ver os outros", async () => {
    stubApi(FULL);
    render(wrap(<App />));
    expect(await screen.findByText("REQ-001 · /orders: HTTP 500")).toBeInTheDocument();
    expect(screen.queryByText("REQ-002 · /reports: layout")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Corrigidos" }));
    expect(await screen.findByText("REQ-002 · /reports: layout")).toBeInTheDocument();
    expect(screen.queryByText("REQ-001 · /orders: HTTP 500")).not.toBeInTheDocument();
  });
});

describe("avisos", () => {
  it("avisa quando o cruzamento com a spec termina", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/crossref": () => json({ links: 3, pendencies_created: 1 }) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Cruzar com a spec/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("Cruzamento concluído")).toBeInTheDocument();
    expect(screen.getByText("3 ligações · 1 pendência nova")).toBeInTheDocument();
  });

  it("explica por que o cruzamento falhou, sem jargão", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/crossref": () => json({ error: "LLM is not configured" }, 503) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Cruzar com a spec/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("Não foi possível cruzar com a spec")).toBeInTheDocument();
    expect(screen.getByText(/modelo de IA não está configurado/)).toBeInTheDocument();
  });

  it("avisa quando uma exploração não pôde ser iniciada", async () => {
    stubApi({ ...FULL, "/api/v1/environments/e1/runs": (init) => (init?.method === "POST" ? json({ error: "environment already has an active run" }, 409) : json([])) });
    render(wrap(<App />));
    const button = await screen.findByRole("button", { name: /Nova exploração/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova exploração" })).getByRole("button", { name: /Iniciar exploração/ }));
    expect(await screen.findByText("Não foi possível iniciar o run")).toBeInTheDocument();
    expect(screen.getByText("environment already has an active run")).toBeInTheDocument();
  });
});
