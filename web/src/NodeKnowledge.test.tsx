import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "./api";
import { NodeKnowledge } from "./NodeKnowledge";

const node = (over: Partial<GraphNode>): GraphNode => ({ id: "n1", kind: "page", label: "/clients/new", app_roles: ["advogada"], metadata: {}, ...over });

describe("NodeKnowledge", () => {
  it("says what the agent understood about a screen: what it is, its forms and what happened when they were used", () => {
    render(
      <NodeKnowledge
        node={node({
          metadata: {
            summary: "Cadastro de cliente do escritório.",
            forms: [{ label: "Novo cliente", method: "POST", action: "/clients", purpose: "Cadastrar um cliente", fields: [{ name: "client[name]", label: "Nome", type: "text", required: true }, { name: "client[email]", label: "E-mail", type: "email", required: false }] }],
            controls: [{ label: "Voltar", intent: "navigate", what: "" }, { label: "Remover", intent: "delete", what: "" }],
            actions: [
              { kind: "submit-valid", label: "Salvar", intent: "save", requests: ["POST /clients → 302"], went_to: "/clients/7" },
              { kind: "submit-valid", label: "Remover", intent: "delete", requests: ["DELETE /clients/{id} (bloqueada pela política)"] },
              { kind: "submit-empty", label: "Salvar", intent: "save", requests: [], messages: ["client[name]: Preencha este campo."] },
            ],
          },
        })}
      />,
    );
    const box = screen.getByRole("region", { name: "O que o agente entendeu" });
    expect(within(box).getByText("Cadastro de cliente do escritório.")).toBeInTheDocument();
    expect(within(box).getByText(/Novo cliente/)).toBeInTheDocument();
    expect(within(box).getByText("POST /clients")).toBeInTheDocument();
    expect(within(box).getByText(/Nome\*/)).toBeInTheDocument(); // required marked
    expect(within(box).getByText("POST /clients → 302")).toBeInTheDocument();
    expect(within(box).getByText(/bloqueada pela política/)).toBeInTheDocument();
    expect(within(box).getByText(/Preencha este campo/)).toBeInTheDocument();
    expect(within(box).getByText("/clients/7")).toBeInTheDocument();
    expect(within(box).getAllByText("apagar").length).toBeGreaterThan(0);
  });

  it("explains an endpoint the agent saw in use", () => {
    render(<NodeKnowledge node={node({ kind: "endpoint", label: "PATCH /clients/{id}", metadata: { source: "observed", observed: { statuses: [302], blocked: false, fields: ["client[name]"], triggers: [{ label: "Atualizar", intent: "edit" }], seen_on: "/clients/:id" } } })} />);
    const box = screen.getByRole("region", { name: "O que o agente entendeu" });
    expect(within(box).getByText(/Visto em \/clients\/:id/)).toBeInTheDocument();
    expect(within(box).getByText(/Atualizar/)).toBeInTheDocument();
    expect(within(box).getByText("302")).toBeInTheDocument();
    expect(within(box).getByText("client[name]")).toBeInTheDocument();
  });

  it("marks an endpoint the environment kept the agent from calling", () => {
    render(<NodeKnowledge node={node({ kind: "endpoint", label: "DELETE /clients/{id}", metadata: { source: "observed", observed: { statuses: [], blocked: true, fields: [], triggers: [{ label: "Remover", intent: "delete" }], seen_on: "/clients" } } })} />);
    expect(screen.getByText(/não foi enviada/i)).toBeInTheDocument();
  });

  it("explains a modal by the click that opens it", () => {
    render(<NodeKnowledge node={node({ kind: "modal", label: "/clients › Novo cliente", metadata: { opened_by: "Novo cliente", summary: "Tela /clients › Novo cliente. formulários: Cadastro (POST /clients)" } })} />);
    expect(screen.getByText(/Abre ao clicar em/)).toBeInTheDocument();
    expect(screen.getByText("Novo cliente", { selector: "strong" })).toBeInTheDocument();
  });

  it("renders nothing for a screen the agent only followed a link to", () => {
    const { container } = render(<NodeKnowledge node={node({ metadata: { status: 200, url: "http://x/clients" } })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
