/** The general report of an environment, as the server computes it, and the documents made from it. */

export interface BriefFacts {
  generated_at: string;
  project: string;
  environment: { name: string; base_url: string; destructive_policy: string; kind: string; device?: string };
  users: string[];
  map: {
    explored: boolean;
    pages: number;
    screens: number;
    modals: number;
    endpoints: number;
    commands: number;
    with_picture: number;
    last_explored?: string;
    login_failures?: string[];
    screens_by_user: Record<string, number>;
  };
  specs: { title: string; source: string; requirements: number; by_criticality: Record<string, number>; unlinked: number; need_review: number }[];
  coverage: {
    requirements: number;
    linked: number;
    percent_requirements: number;
    unlinked: { spec: string; key: string; text: string; criticality: string }[];
    unlinked_total?: number;
    screens: number;
    screens_covered: number;
    percent_screens: number;
    screens_without_requirement: string[];
    screens_without_requirement_total?: number;
  };
  capabilities?: {
    total: number;
    covered: number;
    tested: number;
    failing: number;
    list: { key: string; name: string; screens: number; screens_covered: number; screens_tested: number; status: "pass" | "fail" | "error" | "skipped" | "untested" }[];
  };
  regression: {
    finished_at: string;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    users: { user: string; passed: number; failed: number; errored: number; skipped: number }[];
    tested_as: string[];
    failing_requirements: { key: string; text: string; criticality: string; failing_users: string[] }[];
    stale: boolean;
  } | null;
  bugs: { open: number; critical: number; high: number; fixed: number; list: { title: string; severity: string; status: string; users: string[] }[] };
  /** What the security checks found; absent in a report made before they existed. */
  security?: { checked: boolean; checks: number; failed: number; probes: number; open: number; critical: number; high: number; normal: number; fixed: number; list: { title: string; severity: string; status: string; users: string[] }[] };
  access: { route: string; users: string[]; missing_for: string[] }[];
  journeys: { count: number; routes: string[]; without_requirement: string[] };
  open_pendencies: number;
  issues: { code: string; severity: "alta" | "média" | "baixa"; area: string; message: string; items?: string[] }[];
  readiness: { id: string; label: string; ok: boolean; detail: string }[];
}

export interface BriefNarrative {
  source: "template" | "ai";
  executive_summary: string;
  sections: { id: string; title: string; body: string }[];
  recommendations: string[];
}

export interface BriefResponse {
  facts: BriefFacts;
  narrative: BriefNarrative;
}

export type BriefFormat = "html" | "md" | "json";

/** "… e mais N" when the report lists only the first ones of a longer list. */
const more = (shown: number, total: number | undefined): string => (total !== undefined && total > shown ? `… e mais ${total - shown}` : "");

const SEVERITY_LABEL: Record<string, string> = { critical: "crítico", high: "alto", normal: "normal" };
const SOURCE_LABEL: Record<string, string> = { text: "texto", auto: "gerada do mapa", openapi: "OpenAPI", document: "documento" };
const STATUS_LABEL: Record<string, string> = { pass: "passou", fail: "falhou", error: "erro", skipped: "pulada", untested: "não testada" };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const date = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
/** A finding's title without the "Segurança · " the bug list carries, since the table says it already. */
const findingTitle = (t: string): string => t.replace(/^Segurança · /, "");
const who = (users: string[]): string => (users.length > 0 ? users.join(", ") : "—");
const sourceNote = (n: BriefNarrative): string => (n.source === "ai" ? "resumo escrito por IA a partir dos fatos abaixo, sem acrescentar números" : "texto padrão, escrito a partir dos fatos");

// ---- Markdown ----

const cell = (s: string | number): string => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: (string | number)[][]): string =>
  rows.length === 0 ? "" : [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

export function renderMarkdown({ facts: f, narrative: n }: BriefResponse): string {
  const out: string[] = [];
  out.push(`# Relatório geral — ${f.project} / ${f.environment.name}`);
  out.push(`${f.environment.base_url} · gerado em ${date(f.generated_at)} · ${sourceNote(n)}`);
  out.push("## Resumo executivo", n.executive_summary);
  out.push("## Pontos de atenção");
  out.push(
    f.issues.length === 0
      ? "Nenhum ponto de atenção."
      : f.issues.map((i) => `- **${i.severity}** (${i.area}): ${i.message}${i.items?.length ? "\n" + i.items.map((it) => `  - ${it}`).join("\n") : ""}`).join("\n"),
  );
  for (const s of n.sections) out.push(`## ${s.title}`, s.body);
  out.push("## Recomendações", n.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n"));
  out.push("## Prontidão da ferramenta", f.readiness.map((c) => `- ${c.ok ? "✅" : "⚠️"} **${c.label}**: ${c.detail}`).join("\n"));

  out.push("## Anexo: dados");
  out.push("### Cobertura por especificação");
  out.push(
    table(
      ["Especificação", "Origem", "Requisitos", "Críticos", "Sem tela", "A revisar"],
      f.specs.map((s) => [s.title, SOURCE_LABEL[s.source] ?? s.source, s.requirements, s.by_criticality["critical"] ?? 0, s.unlinked, s.need_review]),
    ) || "Nenhuma especificação.",
  );
  if (f.coverage.unlinked.length > 0) out.push("### Requisitos sem tela", [...f.coverage.unlinked.map((r) => `- ${r.key}: ${r.text} (${SEVERITY_LABEL[r.criticality] ?? r.criticality})`), more(f.coverage.unlinked.length, f.coverage.unlinked_total)].filter(Boolean).join("\n"));
  if (f.coverage.screens_without_requirement.length > 0) out.push("### Telas sem requisito", [...f.coverage.screens_without_requirement.map((r) => `- ${r}`), more(f.coverage.screens_without_requirement.length, f.coverage.screens_without_requirement_total)].filter(Boolean).join("\n"));
  out.push("### Usuários e telas alcançadas", table(["Usuário", "Telas"], f.users.map((u) => [u, f.map.screens_by_user[u] ?? 0])) || "Nenhum usuário.");
  if (f.capabilities && f.capabilities.total > 0) {
    out.push("### Capacidades de produto");
    out.push(`Total: **${f.capabilities.total}** · cobertas: **${f.capabilities.covered}** · testadas: **${f.capabilities.tested}** · com falha: **${f.capabilities.failing}**`);
    out.push(table(["Capacidade", "Telas", "Cobertas", "Testadas", "Status"], f.capabilities.list.map((c) => [c.name, c.screens, c.screens_covered, c.screens_tested, STATUS_LABEL[c.status] ?? c.status])) || "");
  }
  if (f.access.length > 0) out.push("### Fluxos alternativos", table(["Tela", "Alcançada por", "Não alcançada por"], f.access.map((a) => [a.route, who(a.users), who(a.missing_for)])));
  out.push("### Última regressão");
  if (!f.regression) out.push("Nenhuma regressão executada.");
  else {
    const r = f.regression;
    out.push(`Em ${date(r.finished_at)}, testada como ${who(r.tested_as)}: ${r.passed} aprovadas, ${r.failed} reprovadas, ${r.errored} com erro, ${r.skipped} puladas.${r.stale ? " (testou uma versão antiga do mapa)" : ""}`);
    out.push(table(["Usuário", "Aprovadas", "Reprovadas", "Puladas"], r.users.map((u) => [u.user || "sem usuário", u.passed, u.failed + u.errored, u.skipped])));
    if (r.failing_requirements.length > 0) out.push(table(["Requisito", "Criticidade", "Falha para", "Texto"], r.failing_requirements.map((q) => [q.key, SEVERITY_LABEL[q.criticality] ?? q.criticality, who(q.failing_users), q.text])));
  }
  out.push("### Bugs abertos", table(["Bug", "Gravidade", "Status", "Afeta"], f.bugs.list.map((b) => [b.title, SEVERITY_LABEL[b.severity] ?? b.severity, b.status, who(b.users)])) || "Nenhum bug aberto.");
  const sec = f.security;
  if (sec && (sec.checked || sec.open > 0)) {
    out.push("### Falhas de segurança abertas");
    if (sec.checked) out.push(`Última execução com as verificações: ${sec.checks} verificações, ${sec.failed} com falha; injeções tentadas em ${sec.probes} endereços com parâmetros.`);
    out.push(sec.list.length === 0 ? "Nenhuma falha de segurança aberta." : table(["Falha", "Gravidade", "Status", "Afeta"], sec.list.map((b) => [findingTitle(b.title), SEVERITY_LABEL[b.severity] ?? b.severity, b.status, who(b.users)])));
  }
  return out.filter((p) => p !== "").join("\n\n") + "\n";
}

// ---- HTML ----

/** Paragraphs, bold, bullet and numbered lists: all the narrative uses. Everything is escaped first. */
export function mdToHtml(md: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const html: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) html.push(`<p>${para.join(" ")}</p>`);
    para = [];
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const number = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || number) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? number)?.[1] ?? ""));
    } else if (line === "") {
      flush();
      flushPara();
    } else {
      flush();
      para.push(inline(line));
    }
  }
  flush();
  flushPara();
  return html.join("");
}

const th = (cols: string[]) => `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
const tr = (cols: (string | number)[]) => `<tr>${cols.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`;
const htmlTable = (head: string[], rows: (string | number)[][]) => (rows.length === 0 ? "" : `<table>${th(head)}${rows.map(tr).join("")}</table>`);

const CSS = `
:root{--ink:#1c1f2b;--muted:#6c7084;--line:#e3e5ee;--blue:#0b5cff;--ok:#12a150;--warn:#e8890c;--bad:#e5484d}
*{box-sizing:border-box}
body{margin:0;padding:32px 40px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff;max-width:900px;margin-inline:auto}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--line)}h3{font-size:14px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.meta{color:var(--muted);font-size:12px}
.summary{margin:16px 0;padding:14px 16px;border-left:4px solid var(--blue);background:#f4f7ff;border-radius:6px;font-size:15px}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.kpi{flex:1 1 130px;padding:10px 12px;border:1px solid var(--line);border-radius:10px}.kpi b{display:block;font-size:22px}.kpi span{font-size:11px;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase}
.issue{margin:8px 0;padding:8px 12px;border:1px solid var(--line);border-left-width:4px;border-radius:6px}.issue.alta{border-left-color:var(--bad)}.issue.média{border-left-color:var(--warn)}.issue.baixa{border-left-color:var(--blue)}
.issue ul{margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--muted)}.tag{display:inline-block;padding:0 8px;border-radius:99px;font-size:11px;font-weight:700;color:#fff;background:var(--blue)}.tag.alta{background:var(--bad)}.tag.média{background:var(--warn)}
.check{margin:4px 0}.ok{color:var(--ok)}.no{color:var(--warn)}
footer{margin-top:36px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}.issue,table{break-inside:avoid}}`;

export function renderHtml({ facts: f, narrative: n }: BriefResponse): string {
  const r = f.regression;
  const kpi = (value: string | number, label: string) => `<div class="kpi"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`;
  const parts: string[] = [];
  parts.push(`<h1>Relatório geral</h1><div class="meta">${esc(f.project)} / ${esc(f.environment.name)} · ${esc(f.environment.base_url)} · gerado em ${esc(date(f.generated_at))}</div>`);
  parts.push(`<h2>Resumo executivo</h2><div class="summary">${esc(n.executive_summary)}</div>`);
  parts.push(
    `<div class="kpis">${[
      kpi(f.map.screens, "telas mapeadas"),
      kpi(f.users.length, "usuários explorados"),
      kpi(`${f.coverage.percent_requirements}%`, "requisitos ligados a telas"),
      kpi(`${f.coverage.percent_screens}%`, "telas com requisito"),
      ...(f.capabilities ? [kpi(`${f.capabilities.tested}/${f.capabilities.total}`, "capacidades testadas"), kpi(f.capabilities.failing, "capacidades com falha")] : []),
      kpi(r ? `${r.passed} / ${r.failed + r.errored}` : "—", "aprovadas / reprovadas"),
      kpi(f.bugs.open, "bugs abertos"),
      ...(f.security && (f.security.checked || f.security.open > 0) ? [kpi(f.security.open, "falhas de segurança abertas")] : []),
    ].join("")}</div>`,
  );
  parts.push(`<h2>Pontos de atenção</h2>`);
  parts.push(
    f.issues.length === 0
      ? "<p>Nenhum ponto de atenção.</p>"
      : f.issues
          .map((i) => `<div class="issue ${esc(i.severity)}"><span class="tag ${esc(i.severity)}">${esc(i.severity)}</span> <span class="meta">${esc(i.area)}</span><br>${esc(i.message)}${i.items?.length ? `<ul>${i.items.map((it) => `<li>${esc(it)}</li>`).join("")}</ul>` : ""}</div>`)
          .join(""),
  );
  for (const s of n.sections) parts.push(`<h2>${esc(s.title)}</h2>${mdToHtml(s.body)}`);
  parts.push(`<h2>Recomendações</h2><ol>${n.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`);
  parts.push(`<h2>Prontidão da ferramenta</h2>${f.readiness.map((c) => `<div class="check"><span class="${c.ok ? "ok" : "no"}">${c.ok ? "✔" : "⚠"}</span> <b>${esc(c.label)}</b>: ${esc(c.detail)}</div>`).join("")}`);

  parts.push("<h2>Anexo: dados</h2><h3>Cobertura por especificação</h3>");
  parts.push(htmlTable(["Especificação", "Origem", "Requisitos", "Críticos", "Sem tela", "A revisar"], f.specs.map((s) => [s.title, SOURCE_LABEL[s.source] ?? s.source, s.requirements, s.by_criticality["critical"] ?? 0, s.unlinked, s.need_review])) || "<p>Nenhuma especificação.</p>");
  if (f.coverage.unlinked.length > 0) parts.push("<h3>Requisitos sem tela</h3>", htmlTable(["Requisito", "Criticidade", "Texto"], f.coverage.unlinked.map((x) => [x.key, SEVERITY_LABEL[x.criticality] ?? x.criticality, x.text])), `<p class="meta">${esc(more(f.coverage.unlinked.length, f.coverage.unlinked_total))}</p>`);
  if (f.coverage.screens_without_requirement.length > 0) parts.push("<h3>Telas sem requisito</h3>", `<p>${f.coverage.screens_without_requirement.map(esc).join(", ")} ${esc(more(f.coverage.screens_without_requirement.length, f.coverage.screens_without_requirement_total))}</p>`);
  parts.push("<h3>Usuários e telas alcançadas</h3>", htmlTable(["Usuário", "Telas"], f.users.map((u) => [u, f.map.screens_by_user[u] ?? 0])) || "<p>Nenhum usuário.</p>");
  if (f.capabilities && f.capabilities.total > 0) {
    parts.push("<h3>Capacidades de produto</h3>");
    parts.push(`<p>Total: <b>${f.capabilities.total}</b> · cobertas: <b>${f.capabilities.covered}</b> · testadas: <b>${f.capabilities.tested}</b> · com falha: <b>${f.capabilities.failing}</b>.</p>`);
    parts.push(htmlTable(["Capacidade", "Telas", "Cobertas", "Testadas", "Status"], f.capabilities.list.map((c) => [c.name, c.screens, c.screens_covered, c.screens_tested, STATUS_LABEL[c.status] ?? c.status])));
  }
  if (f.access.length > 0) parts.push("<h3>Fluxos alternativos</h3>", htmlTable(["Tela", "Alcançada por", "Não alcançada por"], f.access.map((a) => [a.route, who(a.users), who(a.missing_for)])));
  parts.push("<h3>Última regressão</h3>");
  if (!r) parts.push("<p>Nenhuma regressão executada.</p>");
  else {
    parts.push(`<p>Em ${esc(date(r.finished_at))}, testada como ${esc(who(r.tested_as))}: ${r.passed} aprovadas, ${r.failed} reprovadas, ${r.errored} com erro, ${r.skipped} puladas.${r.stale ? " <b>Testou uma versão antiga do mapa.</b>" : ""}</p>`);
    parts.push(htmlTable(["Usuário", "Aprovadas", "Reprovadas", "Puladas"], r.users.map((u) => [u.user || "sem usuário", u.passed, u.failed + u.errored, u.skipped])));
    if (r.failing_requirements.length > 0) parts.push(htmlTable(["Requisito", "Criticidade", "Falha para", "Texto"], r.failing_requirements.map((q) => [q.key, SEVERITY_LABEL[q.criticality] ?? q.criticality, who(q.failing_users), q.text])));
  }
  parts.push("<h3>Bugs abertos</h3>", htmlTable(["Bug", "Gravidade", "Status", "Afeta"], f.bugs.list.map((b) => [b.title, SEVERITY_LABEL[b.severity] ?? b.severity, b.status, who(b.users)])) || "<p>Nenhum bug aberto.</p>");
  const sec = f.security;
  if (sec && (sec.checked || sec.open > 0)) {
    parts.push("<h3>Falhas de segurança abertas</h3>");
    if (sec.checked) parts.push(`<p>Última execução com as verificações: ${sec.checks} verificações, ${sec.failed} com falha; injeções tentadas em ${sec.probes} endereços com parâmetros.</p>`);
    parts.push(sec.list.length === 0 ? "<p>Nenhuma falha de segurança aberta.</p>" : htmlTable(["Falha", "Gravidade", "Status", "Afeta"], sec.list.map((b) => [findingTitle(b.title), SEVERITY_LABEL[b.severity] ?? b.severity, b.status, who(b.users)])));
  }
  parts.push(`<footer>Gerado pelo QA Autônomo. Os números vêm do que a plataforma observou na aplicação; ${esc(sourceNote(n))}.</footer>`);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relatório geral — ${esc(f.project)} / ${esc(f.environment.name)}</title><style>${CSS}</style></head><body>${parts.join("\n")}</body></html>`;
}

const slug = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A name that is safe on any system and says what it is. */
export function fileName(r: BriefResponse, format: BriefFormat): string {
  return `relatorio-${slug(r.facts.project)}-${slug(r.facts.environment.name)}-${r.facts.generated_at.slice(0, 10)}.${format}`;
}

export function render(r: BriefResponse, format: BriefFormat): { body: string; type: string } {
  switch (format) {
    case "html":
      return { body: renderHtml(r), type: "text/html;charset=utf-8" };
    case "md":
      return { body: renderMarkdown(r), type: "text/markdown;charset=utf-8" };
    case "json":
      return { body: JSON.stringify(r, null, 2), type: "application/json;charset=utf-8" };
  }
}
