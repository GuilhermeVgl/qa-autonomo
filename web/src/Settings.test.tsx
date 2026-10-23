import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function stub(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const handler = routes[`${call.method} ${path}`];
      return handler ? handler(call) : json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

function mount(props: Partial<{ projectId: string; envId: string; onSelectProject: (id: string) => void }> = { projectId: "p1", envId: "e1" }) {
  const onChanged = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Settings token="dev:ana@x.com" projectId={props.projectId} envId={props.envId} onChanged={onChanged} {...(props.onSelectProject ? { onSelectProject: props.onSelectProject } : {})} />
    </QueryClientProvider>,
  );
  return onChanged;
}

const openTab = (name: string) => userEvent.click(screen.getByRole("tab", { name }));

describe("Settings", () => {
  it("organiza as configurações em seções", () => {
    stub({});
    mount();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Projetos", "Ambientes", "Credenciais", "Tokens de CI", "Agendamentos", "Aparência"]);
    expect(screen.getByRole("tab", { name: "Projetos" })).toHaveAttribute("aria-selected", "true");
  });

  it("lista os projetos, marca o que está em uso e deixa trocar", async () => {
    stub({ "GET /api/v1/projects": () => json([{ id: "p1", name: "Portal" }, { id: "p2", name: "Backoffice" }]) });
    const onSelectProject = vi.fn();
    mount({ projectId: "p1", envId: "e1", onSelectProject });
    expect(await screen.findByText("Portal")).toBeInTheDocument();
    expect(screen.getByText("Em uso")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Usar este" }));
    expect(onSelectProject).toHaveBeenCalledWith("p2");
  });

  it("cria um projeto", async () => {
    const calls = stub({ "POST /api/v1/projects": () => json({ id: "p2", name: "Novo" }, 201) });
    const onChanged = mount();
    await userEvent.type(screen.getByLabelText(/Nome do projeto/), "Novo");
    await userEvent.click(screen.getByRole("button", { name: /Criar projeto/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/projects", method: "POST", body: { name: "Novo" } }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("lista os ambientes com o que importa de cada um", async () => {
    stub({
      "GET /api/v1/projects/p1/environments": () =>
        json([
          { id: "e1", name: "hml", base_url: "https://hml.x.com", kind: "web", device: null, destructive_policy: "block", is_production: false },
          { id: "e2", name: "prod", base_url: "https://x.com", kind: "web", device: "iPhone 13", destructive_policy: "block", is_production: true },
        ]),
    });
    mount();
    await openTab("Ambientes");
    expect(await screen.findByText("https://hml.x.com")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Ambientes" })).getByText("iPhone 13")).toBeInTheDocument();
    expect(screen.getByText(/Produção \(não executa\)/)).toBeInTheDocument();
    expect(screen.getAllByText("Ações destrutivas bloqueadas")).toHaveLength(2);
  });

  it("cria um ambiente mobile escolhendo o dispositivo", async () => {
    const calls = stub({ "POST /api/v1/projects/p1/environments": () => json({ id: "e2" }, 201) });
    mount();
    await openTab("Ambientes");
    await userEvent.type(screen.getByLabelText(/Nome do ambiente/), "hml-mobile");
    await userEvent.type(screen.getByLabelText(/URL base/), "https://hml.example.com");
    await userEvent.selectOptions(screen.getByLabelText(/Dispositivo/), "iPhone 13");
    await userEvent.click(screen.getByRole("button", { name: /Criar ambiente/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/v1/projects/p1/environments",
        method: "POST",
        body: { name: "hml-mobile", base_url: "https://hml.example.com", device: "iPhone 13" },
      }),
    );
  });

  it("cria um ambiente que deixa o agente alterar dados, avisando o que isso significa", async () => {
    const calls = stub({ "POST /api/v1/projects/p1/environments": () => json({ id: "e4" }, 201) });
    mount();
    await openTab("Ambientes");
    await userEvent.type(screen.getByLabelText(/Nome do ambiente/), "testes");
    await userEvent.type(screen.getByLabelText(/URL base/), "https://testes.example.com");
    expect(screen.getByLabelText(/Ações que alteram dados/)).toHaveValue("block"); // the safe choice is the default
    await userEvent.selectOptions(screen.getByLabelText(/Ações que alteram dados/), "allow");
    expect(screen.getByText(/cria, edita e apaga dados/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Criar ambiente/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/v1/projects/p1/environments",
        method: "POST",
        body: { name: "testes", base_url: "https://testes.example.com", destructive_policy: "allow" },
      }),
    );
  });

  it("cria um ambiente de terminal com o binário e a imagem do runner", async () => {
    const calls = stub({ "POST /api/v1/projects/p1/environments": () => json({ id: "e3" }, 201) });
    mount();
    await openTab("Ambientes");
    await userEvent.type(screen.getByLabelText(/Nome do ambiente/), "cli");
    await userEvent.click(screen.getByRole("radio", { name: "Terminal (CLI)" }));
    expect(screen.queryByLabelText(/URL base/)).not.toBeInTheDocument(); // no URL, no device for a CLI
    expect(screen.queryByLabelText(/Dispositivo/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Binário do CLI/), "samplecli");
    await userEvent.type(screen.getByLabelText(/Imagem do runner/), "registry.local/samplecli:1");
    await userEvent.click(screen.getByRole("button", { name: /Criar ambiente/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/v1/projects/p1/environments",
        method: "POST",
        body: { name: "cli", kind: "terminal", binary: "samplecli", image: "registry.local/samplecli:1" },
      }),
    );
  });

  it("mostra o erro devolvido pela API ao criar um ambiente inválido", async () => {
    stub({ "POST /api/v1/projects/p1/environments": () => json({ error: "base_url must be http or https" }, 400) });
    mount();
    await openTab("Ambientes");
    await userEvent.type(screen.getByLabelText(/Nome do ambiente/), "x");
    await userEvent.type(screen.getByLabelText(/URL base/), "ftp://x.com");
    await userEvent.click(screen.getByRole("button", { name: /Criar ambiente/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/base_url must be http or https/);
  });

  it("lista as credenciais e salva uma nova sem exibir a senha de volta", async () => {
    const calls = stub({
      "GET /api/v1/environments/e1/credentials": () => json([{ id: "c0", app_role: "operator", kind: "login" }]),
      "PUT /api/v1/environments/e1/credentials": () => json({ id: "c1", app_role: "admin", kind: "login" }),
    });
    mount();
    await openTab("Credenciais");
    expect(await screen.findByText("operator")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Nome do usuário/), "admin");
    await userEvent.type(screen.getByLabelText(/Login/), "adm");
    const pwd = screen.getByLabelText(/Senha/);
    expect(pwd).toHaveAttribute("type", "password");
    await userEvent.type(pwd, "S3cret!");
    await userEvent.click(screen.getByRole("button", { name: /Salvar credencial/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "/api/v1/environments/e1/credentials", method: "PUT", body: { app_role: "admin", kind: "login", payload: { username: "adm", password: "S3cret!" } } }),
    );
    expect(await screen.findByText(/Credencial salva/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("S3cret!")).not.toBeInTheDocument();
  });

  it("salva um login só com usuário (sem senha), para SSO", async () => {
    const calls = stub({
      "GET /api/v1/environments/e1/credentials": () => json([]),
      "PUT /api/v1/environments/e1/credentials": () => json({ id: "c1", app_role: "sso", kind: "login" }),
    });
    mount();
    await openTab("Credenciais");
    await userEvent.type(await screen.findByLabelText(/Nome do usuário/), "sso");
    await userEvent.type(screen.getByLabelText(/Login/), "ana@x.com");
    expect(screen.getByLabelText(/Senha/)).not.toBeRequired();
    await userEvent.click(screen.getByRole("button", { name: /Salvar credencial/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/credentials", method: "PUT", body: { app_role: "sso", kind: "login", payload: { username: "ana@x.com" } } }));
  });

  it("exclui uma credencial", async () => {
    const calls = stub({
      "GET /api/v1/environments/e1/credentials": () => json([{ id: "c0", app_role: "operator", kind: "login" }]),
      "DELETE /api/v1/credentials/c0": () => new Response(null, { status: 204 }),
    });
    mount();
    await openTab("Credenciais");
    await userEvent.click(await screen.findByRole("button", { name: /Excluir operator/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/credentials/c0", method: "DELETE", body: undefined }));
  });

  it("cria um token de CI e mostra o segredo uma única vez; lista e revoga", async () => {
    const calls = stub({
      "GET /api/v1/projects/p1/tokens": () => json([{ id: "t1", name: "pipeline", scopes: ["run:create", "run:read"], last_used_at: null }]),
      "POST /api/v1/projects/p1/tokens": () => json({ id: "t2", name: "novo", scopes: ["run:create", "run:read"], token: "qat_SEGREDO" }, 201),
      "DELETE /api/v1/tokens/t1": () => new Response(null, { status: 204 }),
    });
    mount();
    await openTab("Tokens de CI");
    expect(await screen.findByText("pipeline")).toBeInTheDocument();
    expect(screen.getByText(/nunca usado/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Nome do token/), "novo");
    await userEvent.click(screen.getByRole("button", { name: /Criar token/ }));
    expect(await screen.findByText("qat_SEGREDO")).toBeInTheDocument();
    expect(screen.getByText(/não será mostrado novamente/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copiar/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Revogar pipeline/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/tokens/t1", method: "DELETE", body: undefined }));
  });

  it("cria, pausa e remove agendamentos, descrevendo a frequência em português", async () => {
    const calls = stub({
      "GET /api/v1/environments/e1/schedules": () => json([{ id: "sc1", run_type: "exploration", cron: "0 2 * * *", enabled: true, next_run_at: "2026-10-02T02:00:00Z", last_run_at: null }]),
      "POST /api/v1/environments/e1/schedules": () => json({ id: "sc2" }, 201),
      "PATCH /api/v1/schedules/sc1": () => json({ id: "sc1", enabled: false }),
      "DELETE /api/v1/schedules/sc1": () => new Response(null, { status: 204 }),
    });
    mount();
    await openTab("Agendamentos");
    expect(await screen.findByText("Todo dia às 02:00", { selector: "strong" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/Tipo do agendamento/), "regression");
    await userEvent.selectOptions(screen.getByLabelText(/Frequência/), "0 */6 * * *");
    expect(screen.getByLabelText(/Cron/)).toHaveValue("0 */6 * * *");
    await userEvent.click(screen.getByRole("button", { name: /Criar agendamento/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/schedules", method: "POST", body: { run_type: "regression", cron: "0 */6 * * *" } }));
    await userEvent.click(screen.getByRole("button", { name: /Pausar/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/schedules/sc1", method: "PATCH", body: { enabled: false } }));
    await userEvent.click(screen.getByRole("button", { name: /Remover agendamento/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/schedules/sc1", method: "DELETE", body: undefined }));
  });

  it("aceita uma frequência personalizada digitada", async () => {
    const calls = stub({ "POST /api/v1/environments/e1/schedules": () => json({ id: "sc2" }, 201) });
    mount();
    await openTab("Agendamentos");
    const cron = screen.getByLabelText(/Cron/);
    await userEvent.clear(cron);
    await userEvent.type(cron, "30 22 * * 1-5");
    expect(screen.getByLabelText(/Frequência/)).toHaveValue("custom");
    await userEvent.click(screen.getByRole("button", { name: /Criar agendamento/ }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/environments/e1/schedules", method: "POST", body: { run_type: "exploration", cron: "30 22 * * 1-5" } }));
  });

  it("desabilita o que depende de projeto ou ambiente quando nenhum está selecionado", async () => {
    stub({});
    mount({});
    await openTab("Ambientes");
    expect(screen.getByRole("button", { name: /Criar ambiente/ })).toBeDisabled();
    await openTab("Credenciais");
    expect(screen.getByRole("button", { name: /Salvar credencial/ })).toBeDisabled();
    await openTab("Tokens de CI");
    expect(screen.getByRole("button", { name: /Criar token/ })).toBeDisabled();
    await openTab("Agendamentos");
    expect(screen.getByRole("button", { name: /Criar agendamento/ })).toBeDisabled();
  });

  it("troca o tema e lembra da escolha", async () => {
    stub({});
    mount();
    await openTab("Aparência");
    await userEvent.click(screen.getByRole("radio", { name: "Escuro" }));
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("qa_theme")).toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: "Claro" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });
});
