import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecDialog } from "./SpecDialog";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const RESULT = {
  spec: { id: "s2", version: 2, title: "API" },
  requirements: [
    { key: "GET /orders", text: "GET /orders responde 200", criticality: "normal", status: "new" },
    { key: "POST /orders", text: "POST /orders responde 201", criticality: "high", status: "unchanged" },
  ],
  removed: [{ key: "GET /old", text: "x", criticality: "normal" }],
  skipped: ["GET /ping"],
};

function mount(handler: (body: Record<string, string>) => Promise<Response> | Response, props: Partial<Parameters<typeof SpecDialog>[0]> = {}) {
  const sent: Record<string, string>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      sent.push(body);
      return handler(body);
    }),
  );
  const onClose = vi.fn();
  const onCrossref = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SpecDialog token="dev:a@x.com" projectId="p1" canCrossref onCrossref={onCrossref} onClose={onClose} {...props} />
    </QueryClientProvider>,
  );
  return { sent, onClose, onCrossref };
}

async function fill(title: string, content: string) {
  await userEvent.type(screen.getByLabelText(/Título da spec/), title);
  await userEvent.click(screen.getByText(content.startsWith("openapi") ? "OpenAPI" : "Texto (IA)"));
  await userEvent.click(screen.getByLabelText(/Conteúdo da spec/));
  await userEvent.paste(content);
}

describe("SpecDialog", () => {
  it("only lets you send once there is a title and some content", async () => {
    mount(() => json(RESULT, 201));
    const send = screen.getByRole("button", { name: "Enviar spec" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Título da spec/), "API");
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Conteúdo da spec/));
    await userEvent.paste("openapi: 3.0.0");
    expect(send).toBeEnabled();
  });

  it("sends an OpenAPI spec and shows what came out of it", async () => {
    const { sent } = mount(() => json(RESULT, 201));
    await fill("API", "openapi: 3.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Enviar spec" }));
    expect(await screen.findByText("Versão 2 salva")).toBeInTheDocument();
    expect(sent).toEqual([{ title: "API", source_type: "openapi", text: "openapi: 3.0.0" }]);
    expect(screen.getByText(/2 requisitos · 1 novo · 1 removido/)).toBeInTheDocument();
    expect(screen.getByText(/1 operação sem resposta 2xx foi ignorada/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Requisitos extraídos" })).toHaveTextContent("POST /orders responde 201");
  });

  it("shows the progress while the server works and keeps the window from being closed", async () => {
    let finish: (r: Response) => void = () => undefined;
    const { onClose } = mount(() => new Promise<Response>((r) => (finish = r)));
    await fill("Regras", "Cobrar em até 30 dias");
    await userEvent.click(screen.getByRole("button", { name: "Enviar spec" }));
    expect(await screen.findByText("Extraindo os requisitos com IA")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Processando/ })).toBeInTheDocument();
    expect(screen.getByText("Especificação enviada")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    finish(json(RESULT, 201));
    expect(await screen.findByText("Versão 2 salva")).toBeInTheDocument();
  });

  it("explains a missing LLM in plain words and lets you go back without losing the text", async () => {
    mount(() => json({ error: "LLM is not configured" }, 503));
    await fill("Regras", "Cobrar em até 30 dias");
    await userEvent.click(screen.getByRole("button", { name: "Enviar spec" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/modelo de IA não está configurado/);
    await userEvent.click(screen.getByRole("button", { name: "Voltar e editar" }));
    expect(screen.getByLabelText(/Conteúdo da spec/)).toHaveValue("Cobrar em até 30 dias");
  });

  it("fills the form from a file and recognises an OpenAPI document", async () => {
    const { sent } = mount(() => json(RESULT, 201));
    const file = new File(["openapi: 3.0.0\ninfo:\n  title: x\n"], "pedidos-api.yaml", { type: "application/x-yaml" });
    await userEvent.upload(screen.getByLabelText("Arquivo da spec"), file);
    await waitFor(() => expect(screen.getByLabelText(/Conteúdo da spec/)).toHaveValue("openapi: 3.0.0\ninfo:\n  title: x\n"));
    expect(screen.getByLabelText(/Título da spec/)).toHaveValue("pedidos-api");
    expect(screen.getByRole("radio", { name: "OpenAPI" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Enviar spec" }));
    await screen.findByText("Versão 2 salva");
    expect(sent[0]).toMatchObject({ source_type: "openapi", title: "pedidos-api" });
  });

  it("offers to cross the new requirements with the map", async () => {
    const { onClose, onCrossref } = mount(() => json(RESULT, 201));
    await fill("API", "openapi: 3.0.0");
    await userEvent.click(screen.getByRole("button", { name: "Enviar spec" }));
    await userEvent.click(await screen.findByRole("button", { name: /Cruzar com o mapa/ }));
    expect(onCrossref).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
