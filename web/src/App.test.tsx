import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./GraphView", () => ({
  GraphView: ({ graph, onSelect }: { graph: { nodes: { id: string; label: string }[] }; onSelect: (n: unknown) => void }) => (
    <div data-testid="graph">
      {graph.nodes.length} nós
      {graph.nodes.map((n) => (
        <button key={n.id} type="button" onClick={() => onSelect(n)}>
          nó {n.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./useGraphStream", () => ({ useGraphStream: () => undefined }));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubApi(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET" });
      const key = Object.keys(routes).find((k) => path === k);
      return key ? (routes[key] as (i?: RequestInit) => Response)(init) : json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});
const onMap = () => {
  window.location.hash = "#/mapa";
};
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("pede login quando não há sessão", async () => {
    stubApi({ "/api/v1/auth/config": () => json({ mode: "dev" }) });
    render(wrap(<App />));
    expect(await screen.findByRole("button", { name: /Entrar/ })).toBeInTheDocument();
  });

  it("mostra o login por SSO quando o servidor usa OIDC e inicia o fluxo", async () => {
    const calls = stubApi({ "/api/v1/auth/config": () => json({ mode: "oidc", issuer: "https://idp.test/t/v2.0", client_id: "c1" }) });
    const start = vi.fn().mockResolvedValue(undefined);
    render(wrap(<App startSso={start} />));
    await userEvent.click(await screen.findByRole("button", { name: /Entrar com SSO/ }));
    expect(start).toHaveBeenCalledWith({ issuer: "https://idp.test/t/v2.0", clientId: "c1" });
    expect(screen.queryByLabelText(/E-mail/)).not.toBeInTheDocument(); // no local users in OIDC mode
    expect(calls.map((c) => c.path)).toContain("/api/v1/auth/config");
  });

  it("conclui o login quando a URL é o retorno do provedor", async () => {
    stubApi({
      "/api/v1/auth/config": () => json({ mode: "oidc", issuer: "https://idp.test/t/v2.0", client_id: "c1" }),
      "/api/v1/auth/login": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([]),
    });
    const finish = vi.fn().mockResolvedValue("ID.TOKEN.SIG");
    render(wrap(<App finishSso={finish} search="?code=abc&state=xyz" />));
    expect(await screen.findByText(/ana@x.com/)).toBeInTheDocument();
    expect(finish).toHaveBeenCalledWith("?code=abc&state=xyz", { issuer: "https://idp.test/t/v2.0", clientId: "c1" });
    expect(localStorage.getItem("qa_token")).toBe("ID.TOKEN.SIG");
  });

  it("mostra o erro quando o retorno do provedor é inválido", async () => {
    stubApi({ "/api/v1/auth/config": () => json({ mode: "oidc", issuer: "https://idp.test/t/v2.0", client_id: "c1" }) });
    const finish = vi.fn().mockRejectedValue(new Error("OIDC state mismatch"));
    render(wrap(<App finishSso={finish} search="?code=abc&state=bad" />));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível concluir o login/);
    expect(localStorage.getItem("qa_token")).toBeNull();
  });

  it("descarta um token JWT expirado guardado", async () => {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    localStorage.setItem("qa_token", `${b64({ alg: "x" })}.${b64({ exp: 1 })}.s`);
    stubApi({ "/api/v1/auth/config": () => json({ mode: "dev" }) });
    render(wrap(<App />));
    expect(await screen.findByRole("button", { name: /Entrar/ })).toBeInTheDocument();
    expect(localStorage.getItem("qa_token")).toBeNull();
  });

  it("faz login de desenvolvimento e guarda o token", async () => {
    stubApi({
      "/api/v1/auth/config": () => json({ mode: "dev" }),
      "/api/v1/auth/login": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([]),
    });
    render(wrap(<App />));
    await userEvent.type(await screen.findByLabelText(/E-mail/), "ana@x.com");
    await userEvent.click(screen.getByRole("button", { name: /Entrar/ }));
    expect(await screen.findByText(/ana@x.com/)).toBeInTheDocument();
    expect(localStorage.getItem("qa_token")).toBe("dev:ana@x.com");
  });

  it("mostra o grafo do ambiente e permite iniciar uma exploração", async () => {
    onMap();
    localStorage.setItem("qa_token", "dev:ana@x.com");
    const calls = stubApi({
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
      "/api/v1/environments/e1/graph": () =>
        json({ graph: { id: "g1", version: 1 }, nodes: [{ id: "n1", kind: "page", label: "/", app_roles: ["admin"], metadata: {} }], edges: [] }),
      "/api/v1/environments/e1/runs": (init) =>
        init?.method === "POST" ? json({ id: "r1", type: "exploration", status: "queued", summary: {} }, 201) : json([]),
    });
    render(wrap(<App />));
    expect(await screen.findByTestId("graph")).toHaveTextContent("1 nós");
    await userEvent.click(screen.getByRole("button", { name: /Nova exploração/ }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova exploração" })).getByRole("button", { name: /Iniciar exploração/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/runs", method: "POST" }));
  });

  it("volta para o login quando a API responde 401", async () => {
    localStorage.setItem("qa_token", "dev:velho@x.com");
    stubApi({ "/api/v1/auth/config": () => json({ mode: "dev" }), "/api/v1/me": () => json({ error: "unauthorized" }, 401) });
    render(wrap(<App />));
    expect(await screen.findByRole("button", { name: /Entrar/ })).toBeInTheDocument();
    expect(localStorage.getItem("qa_token")).toBeNull();
  });

  it("desabilita a exploração em ambiente de produção", async () => {
    localStorage.setItem("qa_token", "dev:ana@x.com");
    stubApi({
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "prod", base_url: "http://a", is_production: true }]),
      "/api/v1/environments/e1/graph": () => json({ error: "not found" }, 404),
      "/api/v1/environments/e1/runs": () => json([]),
    });
    render(wrap(<App />));
    expect(await screen.findByRole("button", { name: /Nova exploração/ })).toBeDisabled();
  });

  describe("andamento do run", () => {
    beforeEach(onMap);
    const base = {
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
    };
    const running = {
      id: "r1",
      type: "exploration",
      status: "running",
      summary: {},
      budget: { max_pages: 50, max_depth: 4, max_seconds: 600, max_llm_calls: 30 },
      created_at: new Date(Date.now() - 20_000).toISOString(),
      started_at: new Date(Date.now() - 10_000).toISOString(),
      finished_at: null,
    };

    it("mostra o andamento da exploração com o que já foi mapeado", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({
        ...base,
        "/api/v1/environments/e1/graph": () =>
          json({
            graph: { id: "g2", version: 2 },
            nodes: [
              { id: "n1", kind: "page", label: "/", app_roles: ["advogado"], metadata: {} },
              { id: "n2", kind: "page", label: "/clients", app_roles: ["advogado"], metadata: {} },
            ],
            edges: [{ id: "e1", from_node_id: "n1", to_node_id: "n2", key: "k" }],
          }),
        "/api/v1/environments/e1/runs": () => json([running]),
      });
      render(wrap(<App />));
      expect(await screen.findByText("Mapeando a aplicação")).toBeInTheDocument();
      expect(screen.getByText(/2 telas mapeadas/)).toBeInTheDocument();
      expect(screen.getByText(/de até 50/)).toBeInTheDocument();
      expect(screen.getByText(/1 ligação/)).toBeInTheDocument();
    });

    it("avisa que está mapeando enquanto a primeira tela não chega", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({
        ...base,
        "/api/v1/environments/e1/graph": () => json({ graph: { id: "g2", version: 2 }, nodes: [], edges: [] }),
        "/api/v1/environments/e1/runs": () => json([running]),
      });
      render(wrap(<App />));
      expect(await screen.findByText(/Mapeando… as telas vão aparecer aqui/)).toBeInTheDocument();
      expect(screen.getByText(/Aguardando a primeira tela/)).toBeInTheDocument();
    });

    it("mostra que o run está na fila", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({
        ...base,
        "/api/v1/environments/e1/graph": () => json({ error: "not found" }, 404),
        "/api/v1/environments/e1/runs": () => json([{ ...running, status: "queued", started_at: null }]),
      });
      render(wrap(<App />));
      expect(await screen.findByText("Na fila")).toBeInTheDocument();
    });

    it("não mostra o painel quando nenhum run está ativo", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({
        ...base,
        "/api/v1/environments/e1/graph": () => json({ error: "not found" }, 404),
        "/api/v1/environments/e1/runs": () => json([{ ...running, status: "succeeded", finished_at: new Date().toISOString() }]),
      });
      render(wrap(<App />));
      await screen.findByText(/Nenhum grafo ainda/);
      expect(screen.queryByLabelText("Andamento do run")).not.toBeInTheDocument();
    });
  });

  describe("cobertura e pendências", () => {
    const base = {
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
      "/api/v1/environments/e1/graph": () =>
        json({
          graph: { id: "g1", version: 1 },
          nodes: [
            { id: "n1", kind: "page", label: "/orders", app_roles: ["admin"], metadata: {} },
            { id: "n2", kind: "page", label: "/reports", app_roles: ["admin"], metadata: {} },
          ],
          edges: [],
        }),
      "/api/v1/environments/e1/runs": () => json([]),
      "/api/v1/projects/p1/specs": () => json([{ id: "s1", version: 1, title: "v1" }]),
      "/api/v1/specs/s1/coverage?graph_id=g1": () =>
        json({
          requirements: [
            { key: "REQ-001", text: "Pedidos", criticality: "critical", status: "covered", node_ids: ["n1"] },
            { key: "REQ-003", text: "Faturas", criticality: "normal", status: "pending", node_ids: [] },
          ],
          nodes: [
            { node_id: "n1", label: "/orders", status: "covered", requirement_keys: ["REQ-001"] },
            { node_id: "n2", label: "/reports", status: "no_spec", requirement_keys: [] },
          ],
        }),
      "/api/v1/specs/s1/pendencies": () =>
        json([{ id: "pd1", requirement_id: "r3", node_id: null, question: "Qual tela cobre REQ-003?", status: "open", answer: null }]),
    };

    it("resume a cobertura na visão geral", async () => {
      window.location.hash = "#/";
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi(base);
      render(wrap(<App />));
      expect(await screen.findByText(/1 de 2/)).toBeInTheDocument();
      expect(screen.getByText(/requisitos cobertos/)).toBeInTheDocument();
      expect(screen.getByText(/1 tela sem spec/)).toBeInTheDocument();
      expect(screen.getByRole("img", { name: /50% dos requisitos cobertos/ })).toBeInTheDocument();
      expect(within(screen.getByLabelText("Pendências")).getByText("1")).toBeInTheDocument();
    });

    it("lista as pendências abertas no mapa", async () => {
      onMap();
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi(base);
      render(wrap(<App />));
      expect(await screen.findByText(/Qual tela cobre REQ-003\?/)).toBeInTheDocument();
    });

    it("responde a pendência apontando o nó", async () => {
      onMap();
      localStorage.setItem("qa_token", "dev:ana@x.com");
      let body: unknown;
      const calls = stubApi({
        ...base,
        "/api/v1/pendencies/pd1/answer": (init) => {
          body = JSON.parse(String(init?.body));
          return json({ id: "pd1", status: "answered" });
        },
      });
      render(wrap(<App />));
      await screen.findByText(/Qual tela cobre REQ-003\?/);
      await userEvent.selectOptions(screen.getByLabelText(/Tela/), "n2");
      await userEvent.type(screen.getByLabelText(/Resposta/), "Faturas ficam em Relatórios");
      await userEvent.click(screen.getByRole("button", { name: /Responder/ }));
      await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/pendencies/pd1/answer", method: "POST" }));
      expect(body).toEqual({ answer: "Faturas ficam em Relatórios", node_id: "n2" });
    });

    it("dispara o cruzamento com a spec", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      const calls = stubApi({ ...base, "/api/v1/environments/e1/crossref": () => json({ links: 1, pendencies_created: 0 }) });
      render(wrap(<App />));
      const button = await screen.findByRole("button", { name: /Cruzar com a spec/ });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/crossref", method: "POST" }));
    });
  });

  describe("histórico por nó e regressão", () => {
    beforeEach(onMap);
    const graphRoute = () =>
      json({
        graph: { id: "g1", version: 1 },
        nodes: [{ id: "n1", kind: "page", label: "/orders", app_roles: ["admin"], metadata: {} }],
        edges: [],
      });
    const base = {
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
      "/api/v1/environments/e1/graph": graphRoute,
      "/api/v1/environments/e1/runs": (init?: RequestInit) =>
        init?.method === "POST" ? json({ id: "r2", type: "regression", status: "queued", summary: {} }, 201) : json([]),
    };

    it("mostra o histórico do nó selecionado, com resultado e evidência", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({
        ...base,
        "/api/v1/nodes/n1/history": () =>
          json([
            { id: "s2", run_id: "r2", run_type: "regression", run_status: "succeeded", result: "fail", expected: "HTTP < 400", actual: "HTTP 500", started_at: "2026-10-01T12:00:00Z", artifacts: [{ id: "a1", kind: "screenshot", content_type: "image/png", size: 10 }] },
            { id: "s1", run_id: "r1", run_type: "regression", run_status: "succeeded", result: "pass", expected: "HTTP < 400", actual: "HTTP 200, structure unchanged", started_at: "2026-09-30T12:00:00Z", artifacts: [] },
          ]),
        "/api/v1/artifacts/a1/content": () => new Response(new Blob(["png"], { type: "image/png" })),
      });
      const create = vi.fn(() => "blob:evidence-1");
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
      render(wrap(<App />));
      await userEvent.click(await screen.findByRole("button", { name: /nó \/orders/ }));
      expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
      expect(screen.getByText(/structure unchanged/)).toBeInTheDocument();
      expect(screen.getByText("falhou")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Ver evidência/ }));
      const img = await screen.findByRole("img", { name: /evidência/i });
      expect(img).toHaveAttribute("src", "blob:evidence-1");
    });

    it("avisa quando o nó ainda não foi testado", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi({ ...base, "/api/v1/nodes/n1/history": () => json([]) });
      render(wrap(<App />));
      await userEvent.click(await screen.findByRole("button", { name: /nó \/orders/ }));
      expect(await screen.findByText(/Ainda não testado/)).toBeInTheDocument();
    });

    it("dispara uma regressão", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      const calls = stubApi(base);
      render(wrap(<App />));
      const button = await screen.findByRole("button", { name: /Nova regressão/ });
      await waitFor(() => expect(button).toBeEnabled());
      await userEvent.click(button);
      await userEvent.click(within(await screen.findByRole("dialog", { name: "Nova regressão" })).getByRole("button", { name: /Iniciar regressão/ }));
      await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/runs", method: "POST" }));
    });
  });

  describe("bugs e relatório do run", () => {
    beforeEach(onMap);
    const base = {
      "/api/v1/me": () => json({ email: "ana@x.com", role: "owner" }),
      "/api/v1/projects": () => json([{ id: "p1", name: "Portal" }]),
      "/api/v1/projects/p1/environments": () => json([{ id: "e1", name: "hml", base_url: "http://a", is_production: false }]),
      "/api/v1/environments/e1/graph": () => json({ error: "not found" }, 404),
      "/api/v1/environments/e1/runs": () => json([{ id: "r1", type: "regression", status: "succeeded", summary: {} }]),
      "/api/v1/projects/p1/bugs": () =>
        json([{ id: "b1", title: "REQ-001 · /orders: HTTP 500", status: "new", severity: "critical" }]),
      "/api/v1/runs/r1/report": () =>
        json({
          run: { id: "r1", type: "regression", status: "succeeded", duration_seconds: 90 },
          steps: { pass: 3, fail: 1, error: 0, skipped: 0, running: 0 },
          requirements: [],
          bugs: { new: [{ id: "b1" }], recurring: [], fixed: [{ id: "b2" }, { id: "b3" }] },
          cost: { llm_calls: 2, tokens_in: 150, tokens_out: 20, cost: 1 },
        }),
    };

    it("lista os bugs do projeto com severidade e status", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi(base);
      render(wrap(<App />));
      expect(await screen.findByText(/REQ-001 · \/orders: HTTP 500/)).toBeInTheDocument();
      expect(screen.getByText("crítico")).toBeInTheDocument();
    });

    it("mostra o relatório do último run: bugs novos, recorrentes e corrigidos", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      stubApi(base);
      render(wrap(<App />));
      expect(await screen.findByText(/1 novo/)).toBeInTheDocument();
      expect(screen.getByText(/0 recorrentes/)).toBeInTheDocument();
      expect(screen.getByText(/2 corrigidos/)).toBeInTheDocument();
      expect(screen.getByText(/3 passaram · 1 falharam/)).toBeInTheDocument();
      expect(screen.getByText(/1 min 30 s/)).toBeInTheDocument();
    });

    it("reproduz um bug", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      const calls = stubApi({ ...base, "/api/v1/bugs/b1/reproduce": () => json({ id: "r2", type: "regression", status: "queued", summary: {} }, 201) });
      render(wrap(<App />));
      await userEvent.click(await screen.findByRole("button", { name: /Reproduzir/ }));
      await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/bugs/b1/reproduce", method: "POST" }));
    });

    it("marca falso positivo exigindo o motivo", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      let body: unknown;
      stubApi({
        ...base,
        "/api/v1/bugs/b1/status": (init) => {
          body = JSON.parse(String(init?.body));
          return json({ id: "b1", status: "false_positive" });
        },
      });
      render(wrap(<App />));
      await userEvent.click(await screen.findByRole("button", { name: /Falso positivo/ }));
      const send = screen.getByRole("button", { name: /Confirmar falso positivo/ });
      expect(send).toBeDisabled(); // no reason yet
      await userEvent.type(screen.getByLabelText(/Motivo/), "Tela de erro esperada");
      await userEvent.click(send);
      await waitFor(() => expect(body).toEqual({ status: "false_positive", reason: "Tela de erro esperada" }));
    });

    it("confirma um bug", async () => {
      localStorage.setItem("qa_token", "dev:ana@x.com");
      let body: unknown;
      stubApi({ ...base, "/api/v1/bugs/b1/status": (init) => ((body = JSON.parse(String(init?.body))), json({ id: "b1", status: "confirmed" })) });
      render(wrap(<App />));
      await userEvent.click(await screen.findByRole("button", { name: /^Confirmar$/ }));
      await waitFor(() => expect(body).toEqual({ status: "confirmed" }));
    });
  });
});
