import { describe, expect, it } from "vitest";
import { fileName, mdToHtml, renderHtml, renderMarkdown, type BriefResponse } from "./briefReport";

const base: BriefResponse = {
  facts: {
    generated_at: "2026-10-05T14:30:00Z",
    project: "Loja <script>alert(1)</script>",
    environment: { name: "hml", base_url: "https://hml.loja.com", destructive_policy: "block", kind: "web" },
    users: ["admin", "operador"],
    map: { explored: true, pages: 5, screens: 4, modals: 1, endpoints: 1, commands: 0, with_picture: 5, screens_by_user: { admin: 4, operador: 1 } },
    specs: [{ title: "Regras", source: "text", requirements: 3, by_criticality: { critical: 1, high: 1, normal: 1 }, unlinked: 1, need_review: 1 }],
    coverage: {
      requirements: 4,
      linked: 3,
      percent_requirements: 75,
      unlinked: [{ spec: "Regras", key: "REQ-002", text: "O gerente aprova um pedido", criticality: "high" }],
      screens: 4,
      screens_covered: 2,
      percent_screens: 50,
      screens_without_requirement: ["/admin", "/help"],
    },
    capabilities: {
      total: 3,
      covered: 2,
      tested: 2,
      failing: 1,
      list: [
        { key: "orders", name: "Orders", screens: 2, screens_covered: 1, screens_tested: 2, status: "fail" },
        { key: "admin", name: "Admin", screens: 1, screens_covered: 0, screens_tested: 1, status: "pass" },
      ],
    },
    regression: {
      finished_at: "2026-10-05T13:00:00Z",
      passed: 8,
      failed: 2,
      errored: 0,
      skipped: 0,
      users: [{ user: "admin", passed: 8, failed: 0, errored: 0, skipped: 0 }, { user: "operador", passed: 0, failed: 2, errored: 0, skipped: 0 }],
      tested_as: ["admin", "operador"],
      failing_requirements: [{ key: "REQ-001", text: "A advogada vê a lista", criticality: "critical", failing_users: ["operador"] }],
      stale: false,
    },
    bugs: { open: 1, critical: 1, high: 0, fixed: 0, list: [{ title: "/orders: HTTP 500", severity: "critical", status: "new", users: ["operador"] }] },
    access: [{ route: "/admin", users: ["admin"], missing_for: ["operador"] }],
    journeys: { count: 1, routes: ["/orders"], without_requirement: [] },
    open_pendencies: 0,
    issues: [{ code: "failing_critical", severity: "alta", area: "execução", message: "1 requisito crítico falhou na última regressão.", items: ["REQ-001: A advogada vê a lista (falha para operador)"] }],
    readiness: [{ id: "runner", label: "Runner conectado", ok: true, detail: "Há um runner ativo." }, { id: "llm", label: "Modelo de IA configurado", ok: false, detail: "Sem modelo de IA." }],
  },
  narrative: {
    source: "template",
    executive_summary: "No ambiente hml foram mapeadas 4 telas.",
    sections: [
      { id: "scope", title: "Escopo e método", body: "Ambiente **hml** do projeto.\n\n- um\n- dois" },
      { id: "next", title: "Próximos passos", body: "1. Corrigir o bug\n2. Rodar de novo" },
    ],
    recommendations: ["Corrigir o bug crítico de /orders."],
  },
};

describe("renderHtml", () => {
  const html = renderHtml(base);

  it("is a complete document with the standard parts, in order", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const order = ["Resumo executivo", "Pontos de atenção", "Escopo e método", "Próximos passos", "Prontidão da ferramenta", "Anexo"];
    let at = -1;
    for (const part of order) {
      const i = html.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
  });

  it("states the facts with the numbers, the users and the failing requirements", () => {
    for (const want of ["hml", "75%", "REQ-002", "/admin", "operador", "REQ-001", "/orders: HTTP 500", "8", "Modelo de IA configurado", "capacidades testadas", "Capacidades de produto", "Orders"]) {
      expect(html, want).toContain(want);
    }
  });

  it("never lets text from the tested application or the project name run as markup", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("says who wrote the text, so nobody takes a template for a model or the other way round", () => {
    expect(html).toContain("texto padrão");
    expect(renderHtml({ ...base, narrative: { ...base.narrative, source: "ai" } })).toContain("resumo escrito por IA");
  });

  it("copes with an environment that was never explored and has no regression", () => {
    const empty: BriefResponse = {
      facts: { ...base.facts, map: { ...base.facts.map, explored: false, screens: 0, pages: 0 }, regression: null, users: [], access: [], bugs: { open: 0, critical: 0, high: 0, fixed: 0, list: [] }, coverage: { ...base.facts.coverage, requirements: 0, linked: 0, unlinked: [], screens: 0, screens_covered: 0, screens_without_requirement: [] }, issues: [], specs: [] },
      narrative: { ...base.narrative },
    };
    expect(() => renderHtml(empty)).not.toThrow();
    expect(renderHtml(empty)).toContain("Nenhuma regressão");
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(base);

  it("has the same standard parts as headings", () => {
    expect(md).toMatch(/^# Relatório geral/);
    for (const h of ["## Resumo executivo", "## Pontos de atenção", "## Escopo e método", "## Próximos passos", "## Prontidão da ferramenta", "## Anexo"]) expect(md).toContain(h);
  });

  it("keeps the facts as tables and lists a person can read in any editor", () => {
    expect(md).toContain("| Usuário | Aprovadas | Reprovadas | Puladas |");
    expect(md).toContain("| operador | 0 | 2 | 0 |");
    expect(md).toContain("- REQ-002: O gerente aprova um pedido");
  });

  it("says how many more there are when the lists are cut", () => {
    const long = structuredClone(base);
    long.facts.coverage.unlinked_total = 41;
    long.facts.coverage.screens_without_requirement_total = 30;
    expect(renderMarkdown(long)).toContain("… e mais 40");
    expect(renderMarkdown(long)).toContain("… e mais 28");
    expect(renderHtml(long)).toContain("… e mais 40");
  });

  it("escapes the pipe in a table cell, which would break the row", () => {
    const tricky = structuredClone(base);
    tricky.facts.bugs.list[0] = { title: "a | b", severity: "normal", status: "new", users: [] };
    expect(renderMarkdown(tricky)).toContain("a \\| b");
  });
});

describe("mdToHtml", () => {
  it("turns paragraphs, bold, bullet and numbered lists into safe html", () => {
    const out = mdToHtml("Texto **forte** e <b>cru</b>.\n\n- a\n- b\n\n1. um\n2. dois");
    expect(out).toContain("<p>Texto <strong>forte</strong> e &lt;b&gt;cru&lt;/b&gt;.</p>");
    expect(out).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(out).toContain("<ol><li>um</li><li>dois</li></ol>");
  });
});

describe("fileName", () => {
  it("names the file after the environment and the day, safe for any system", () => {
    expect(fileName(base, "html")).toBe("relatorio-loja-script-alert-1-script-hml-2026-10-05.html");
    expect(fileName({ ...base, facts: { ...base.facts, project: "Ação / Cobrança?" } }, "md")).toBe("relatorio-acao-cobranca-hml-2026-10-05.md");
  });
});

describe("the security part of the report", () => {
  const withSecurity: BriefResponse = {
    ...base,
    facts: {
      ...base.facts,
      security: {
        checked: true,
        checks: 40,
        failed: 6,
        probes: 3,
        open: 2,
        critical: 1,
        high: 0,
        normal: 1,
        fixed: 1,
        list: [
          { title: "Segurança · Possível SQL injection: /item (id) devolve erro do banco", severity: "critical", status: "new", users: ["admin", "operador"] },
          { title: "Segurança · <img src=x onerror=alert(1)> ausente", severity: "normal", status: "confirmed", users: [] },
        ],
      },
    },
  };

  it("lists the findings apart from the bugs, in Markdown", () => {
    const md = renderMarkdown(withSecurity);
    expect(md).toContain("### Falhas de segurança abertas");
    expect(md).toContain("| Possível SQL injection: /item (id) devolve erro do banco | crítico | new | admin, operador |");
    expect(md).toContain("40 verificações, 6 com falha");
    expect(md.indexOf("### Falhas de segurança abertas")).toBeGreaterThan(md.indexOf("### Bugs abertos"));
  });

  it("is a KPI and a table in HTML, with whatever the application said escaped", () => {
    const html = renderHtml(withSecurity);
    expect(html).toContain("<h3>Falhas de segurança abertas</h3>");
    expect(html).toContain("falhas de segurança abertas</span>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("says nothing of it for a report made before the checks existed", () => {
    expect(renderMarkdown(base)).not.toContain("Falhas de segurança");
    expect(renderHtml(base)).not.toContain("Falhas de segurança");
  });

  it("says plainly that nothing was found when the checks ran clean", () => {
    const security = { checked: true, checks: 40, failed: 0, probes: 3, open: 0, critical: 0, high: 0, normal: 0, fixed: 1, list: [] };
    const clean = { ...withSecurity, facts: { ...withSecurity.facts, security } };
    expect(renderMarkdown(clean)).toContain("Nenhuma falha de segurança aberta.");
  });
});
