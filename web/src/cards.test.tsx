import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceDetails } from "./cards";

describe("EvidenceDetails: a security finding", () => {
  const doc = {
    kind: "security",
    check: "xss-reflected",
    severity: "high",
    scope: "/search?q",
    user: "admin",
    title: "XSS refletido: o parâmetro q de /search volta na página sem escape",
    routes: ["/search"],
    checked: 3,
    detail: { parameter: "q", tested: "https://app.test/search?q=%22%27%3E%3Cqaxss0%3E", status: 200 },
  };

  it("says what was found, how serious, where and what was tried, in words", () => {
    render(<EvidenceDetails doc={doc} />);
    expect(screen.getByText("Gravidade")).toBeInTheDocument();
    expect(screen.getByText("alta")).toBeInTheDocument();
    expect(screen.getByText("Onde")).toBeInTheDocument();
    expect(screen.getByText("/search")).toBeInTheDocument();
    const tried = screen.getByLabelText("Detalhes da verificação");
    expect(within(tried).getByText("parameter")).toBeInTheDocument();
    expect(within(tried).getByText("q")).toBeInTheDocument();
  });

  it("shows what the application sent as text, never as markup", () => {
    const hostile = { ...doc, detail: { excerpt: '<img src=x onerror="alert(1)"> Resultados' } };
    const { container } = render(<EvidenceDetails doc={hostile} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument();
  });

  it("does not claim a severity for a check that is not one", () => {
    render(<EvidenceDetails doc={{ kind: "page", url: "https://app.test/x", status: 200 }} />);
    expect(screen.queryByText("Gravidade")).not.toBeInTheDocument();
  });
});
