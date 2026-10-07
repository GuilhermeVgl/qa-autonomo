import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, fetchBlob, fetchSteps, type Bug, type GraphNode, type HistoryItem, type Pendency, type RunReport, type RunStep } from "./api";
import { bugStatusLabel, formatDuration, severityLabel, stepResultLabel } from "./format";
import { Icon } from "./icons";
import { useToast } from "./ui";

export function PendencyCard({ pendency, nodes, token, onDone }: { pendency: Pendency; nodes: GraphNode[]; token: string; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [nodeId, setNodeId] = useState(pendency.node_id ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/v1/pendencies/${pendency.id}/answer`, token, {
        method: "POST",
        body: JSON.stringify({ answer, ...(nodeId ? { node_id: nodeId } : {}) }),
      });
      toast.show({ kind: "success", title: "Resposta salva", text: "Ela entra no conhecimento do projeto e vale para as próximas execuções." });
      await onDone();
    } catch {
      setError("Não foi possível salvar a resposta.");
    }
  }

  return (
    <form onSubmit={submit} className="pendency">
      <p>{pendency.question}</p>
      <label>
        Tela
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          <option value="">— nenhuma —</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
              {n.app_roles[0] ? ` (${n.app_roles[0]})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Resposta
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} required />
      </label>
      <button type="submit" className="btn primary sm">
        Responder
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function NodeHistory({ nodeId, token }: { nodeId: string; token: string }) {
  const history = useQuery({
    queryKey: ["history", nodeId],
    queryFn: () => api<HistoryItem[]>(`/api/v1/nodes/${nodeId}/history`, token),
  });
  if (history.isPending) return <p className="meta">Carregando histórico…</p>;
  if (!history.data?.length) return <p className="meta">Ainda não testado.</p>;
  return (
    <ol className="history" aria-label="Histórico do nó">
      {history.data.map((h) => (
        <li key={h.id}>
          <strong className={`pill result-${h.result ?? "running"}`}>{stepResultLabel(h.result ?? "running")}</strong>
          {h.user && <span className="pill user-pill">como {h.user}</span>}
          <span className="meta">
            {h.run_type}
            {h.started_at ? ` · ${new Date(h.started_at).toLocaleString("pt-BR")}` : ""}
          </span>
          <div>{h.actual}</div>
          {h.artifacts.map((a) => (
            <Evidence key={a.id} artifact={a} token={token} />
          ))}
        </li>
      ))}
    </ol>
  );
}

/** What the runner keeps as `http` evidence: inputs, requests, answer. Everything is optional because old runs have less. */
export interface EvidenceDoc {
  kind?: string;
  url?: string;
  final_url?: string;
  status?: number | null;
  role?: string;
  policy?: string;
  result?: string;
  expected?: string;
  actual?: string;
  form?: { method: string; action: string };
  inputs?: { field: string; label?: string; type?: string; value: string }[];
  requests?: { method: string; path: string; status: number | null; blocked?: boolean; resource?: string; fields?: string[] }[];
  messages?: string[];
  dialog?: string | null;
  structure?: { match: boolean };
  // a security finding
  check?: string;
  severity?: string;
  scope?: string;
  user?: string;
  title?: string;
  routes?: string[];
  checked?: number;
  detail?: Record<string, unknown>;
}

/** How serious a security finding is, in words. */
export const securitySeverityLabel = (s: string): string => (s === "critical" ? "crítica" : s === "high" ? "alta" : s === "normal" ? "normal" : s);

const detailValue = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export function EvidenceDetails({ doc }: { doc: EvidenceDoc }) {
  return (
    <dl className="evidence-doc">
      {doc.kind === "security" && (
        <>
          {doc.severity && (
            <>
              <dt>Gravidade</dt>
              <dd>
                <strong className={`pill sev-${doc.severity}`}>{securitySeverityLabel(doc.severity)}</strong>
              </dd>
            </>
          )}
          {doc.title && (
            <>
              <dt>O que foi achado</dt>
              <dd>{doc.title}</dd>
            </>
          )}
          {doc.routes && doc.routes.length > 0 && (
            <>
              <dt>Onde</dt>
              <dd>
                <ul className="evidence-requests">
                  {doc.routes.map((r) => (
                    <li key={r}>
                      <code>{r}</code>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {doc.checked != null && (
            <>
              <dt>Verificado</dt>
              <dd>{doc.checked === 1 ? "1 vez" : `${doc.checked} vezes`}</dd>
            </>
          )}
          {doc.detail && Object.keys(doc.detail).length > 0 && (
            <>
              <dt>Detalhes</dt>
              <dd>
                <table className="evidence-table" aria-label="Detalhes da verificação">
                  <tbody>
                    {Object.entries(doc.detail).map(([k, v]) => (
                      <tr key={k}>
                        <th scope="row">{k}</th>
                        <td>
                          <code>{detailValue(v)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </dd>
            </>
          )}
        </>
      )}
      {doc.form && (
        <>
          <dt>Formulário</dt>
          <dd>
            <code>
              {doc.form.method} {doc.form.action}
            </code>
          </dd>
        </>
      )}
      {doc.url && (
        <>
          <dt>Tela</dt>
          <dd>{doc.url}</dd>
        </>
      )}
      {doc.status != null && (
        <>
          <dt>HTTP devolvido</dt>
          <dd>
            <strong>{doc.status}</strong>
            {doc.final_url && doc.final_url !== doc.url ? ` → ${doc.final_url}` : ""}
          </dd>
        </>
      )}
      {doc.policy && (
        <>
          <dt>Política do ambiente</dt>
          <dd>{doc.policy}</dd>
        </>
      )}
      {doc.inputs && doc.inputs.length > 0 && (
        <>
          <dt>Valores digitados</dt>
          <dd>
            <table className="evidence-table" aria-label="Valores digitados">
              <tbody>
                {doc.inputs.map((i) => (
                  <tr key={i.field}>
                    <th scope="row">{i.label || i.field}</th>
                    <td>
                      <code>{i.value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </dd>
        </>
      )}
      {doc.requests && doc.requests.length > 0 && (
        <>
          <dt>Requisições</dt>
          <dd>
            <ul className="evidence-requests" aria-label="Requisições feitas">
              {doc.requests.map((r, i) => (
                <li key={i}>
                  <code>
                    {r.method} {r.path}
                  </code>{" "}
                  <span className={`pill${r.blocked ? " result-skipped" : r.status != null && r.status >= 400 ? " result-fail" : ""}`}>
                    {r.blocked ? "bloqueada pela política" : (r.status ?? "sem resposta")}
                  </span>
                  {r.fields && r.fields.length > 0 && <span className="meta"> campos: {r.fields.join(", ")}</span>}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {doc.messages && doc.messages.length > 0 && (
        <>
          <dt>Mensagens na tela</dt>
          <dd>{doc.messages.join(" · ")}</dd>
        </>
      )}
      {doc.dialog && (
        <>
          <dt>Diálogo</dt>
          <dd>{doc.dialog}</dd>
        </>
      )}
      {doc.actual && (
        <>
          <dt>Resultado</dt>
          <dd>{doc.actual}</dd>
        </>
      )}
    </dl>
  );
}

export function Evidence({ artifact, token }: { artifact: HistoryItem["artifacts"][number]; token: string }) {
  const [url, setUrl] = useState<string>();
  const [doc, setDoc] = useState<EvidenceDoc>();
  const [text, setText] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  async function load() {
    try {
      const blob = await fetchBlob(`/api/v1/artifacts/${artifact.id}/content`, token);
      if (artifact.kind === "screenshot") setUrl(URL.createObjectURL(blob));
      else if (artifact.kind === "http") setDoc(JSON.parse(await blob.text()) as EvidenceDoc);
      else setText(await blob.text());
    } catch {
      setError(true);
    }
  }
  if (url) return <img className="evidence" src={url} alt={`Evidência: ${artifact.kind}`} />;
  if (doc) return <EvidenceDetails doc={doc} />;
  if (text !== undefined) return <pre className="evidence-text">{text}</pre>;
  const label = artifact.kind === "screenshot" ? "Ver evidência" : artifact.kind === "http" ? "Ver entradas e respostas" : "Ver saída";
  return (
    <>
      <button type="button" className="btn sm" onClick={() => void load()}>
        {label}
      </button>
      {error && <span role="alert"> Não foi possível carregar.</span>}
    </>
  );
}

/** Every check of a run with what was expected, what happened and the evidence kept, pass or fail. */
const PAGE_SIZE = 50;

/**
 * Every check of a run with who it ran as, what was expected, what happened and the evidence kept, pass or fail. A big run
 * has thousands of steps, so the server pages them (problems first) and filters by result and user; this asks for 50 at a time.
 */
export function RunSteps({ runId, token, users = [], kind }: { runId: string; token: string; users?: string[]; kind?: "security" }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [user, setUser] = useState<string>();
  const security = kind === "security";
  const filters = { results: onlyProblems ? ["fail", "error"] : [], ...(user !== undefined ? { user } : {}), ...(security ? { kind } : {}) };
  const steps = useInfiniteQuery({
    queryKey: ["run-steps", runId, onlyProblems, user ?? null, security],
    queryFn: ({ pageParam }) => fetchSteps(token, runId, { ...filters, offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  if (steps.isPending) return <p className="meta">{security ? "Carregando verificações…" : "Carregando checagens…"}</p>;
  const items = steps.data?.pages.flatMap((p) => p.items) ?? [];
  const total = steps.data?.pages[0]?.total ?? 0;
  if (total === 0 && !onlyProblems && user === undefined) return <p className="meta">{security ? "Esta execução não fez verificações de segurança." : "Esta execução não tem checagens."}</p>;
  return (
    <>
      <div className="step-filters">
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          <span>Só falhas e erros</span>
        </label>
        {users.length > 1 && (
          <label>
            Usuário{" "}
            <select value={user ?? "*"} onChange={(e) => setUser(e.target.value === "*" ? undefined : e.target.value)} aria-label="Filtrar por usuário">
              <option value="*">todos</option>
              {users.map((u) => (
                <option key={u || "-"} value={u}>
                  {u || "sem usuário"}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="meta">
          {items.length} de {total}
        </span>
      </div>
      <ol className="step-list" aria-label={security ? "Verificações de segurança" : "Checagens da execução"}>
        {items.map((s) => (
          <li key={s.id}>
            <div className="step-line">
              <strong className={`pill result-${s.result ?? "running"}`}>{stepResultLabel(s.result ?? "running")}</strong>
              {s.security && s.result !== "pass" && <strong className={`pill sev-${s.security.severity}`}>{securitySeverityLabel(s.security.severity)}</strong>}
              {s.user && <span className="pill user-pill">como {s.user}</span>}
              <span className="meta">{s.executor}</span>
              <span>{inputSummary(s.input)}</span>
            </div>
            <div className="meta">Esperado: {s.expected}</div>
            <div>{s.actual}</div>
            {s.artifacts.map((a) => (
              <Evidence key={a.id} artifact={a} token={token} />
            ))}
          </li>
        ))}
      </ol>
      {steps.hasNextPage && (
        <button type="button" className="btn sm" onClick={() => void steps.fetchNextPage()} disabled={steps.isFetchingNextPage}>
          {steps.isFetchingNextPage ? "Carregando…" : `Mostrar mais ${Math.min(PAGE_SIZE, total - items.length)}`}
        </button>
      )}
    </>
  );
}

/** One line about what a step was given: the form and its values, the page, the endpoint. */
function inputSummary(input: RunStep["input"]): string {
  if (!input) return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (str(input["form"])) return str(input["form"]);
  if (str(input["method"]) && str(input["path"])) return `${str(input["method"])} ${str(input["path"])}`;
  if (str(input["check"])) return str(input["scope"]) || str(input["check"]);
  return str(input["url"]) || str(input["command"]) || "";
}

export function ReportCard({ report, bare = false }: { report: RunReport; bare?: boolean }) {
  const { steps, bugs } = report;
  return (
    <section aria-label="Relatório do último run" className={bare ? "report-bare" : "card report"}>
      <div className="card-head">
        <h2>
          <Icon name="chart" size={18} /> Último run ({report.run.type})
        </h2>
      </div>
      <p>
        {steps["pass"] ?? 0} passaram · {steps["fail"] ?? 0} falharam
        {(steps["error"] ?? 0) > 0 ? ` · ${steps["error"]} com erro` : ""} · {formatDuration(report.run.duration_seconds)}
      </p>
      <p>
        🔴 {bugs.new.length} {bugs.new.length === 1 ? "novo" : "novos"} · 🟠 {bugs.recurring.length}{" "}
        {bugs.recurring.length === 1 ? "recorrente" : "recorrentes"} · 🟢 {bugs.fixed.length} {bugs.fixed.length === 1 ? "corrigido" : "corrigidos"}
      </p>
      {report.cost.llm_calls > 0 && (
        <p>
          LLM: {report.cost.llm_calls} chamadas · {report.cost.tokens_in + report.cost.tokens_out} tokens
        </p>
      )}
    </section>
  );
}

export function BugCard({ bug, token, onDone }: { bug: Bug; token: string; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body: unknown, success: string) {
    try {
      await api(`/api/v1/bugs/${bug.id}/${path}`, token, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      setAsking(false);
      toast.show({ kind: "success", title: success });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const open = bug.status === "new" || bug.status === "confirmed" || bug.status === "reopened";
  return (
    <div className="bug">
      <div className="bug-tags">
        {bug.category === "security" && <span className="pill kind-security">Segurança</span>}
        <strong className={`pill sev-${bug.severity}`}>{severityLabel(bug.severity)}</strong>
        <span className={`pill status-${bug.status}`}>{bugStatusLabel(bug.status)}</span>
      </div>
      {/* the "Segurança" tag already says it; the server keeps the prefix in the title so lists elsewhere read well */}
      <p className="bug-title">{bug.category === "security" ? bug.title.replace(/^Segurança · /, "") : bug.title}</p>
      {bug.users && bug.users.length > 0 && (
        <p className="meta bug-users">
          Afeta: {bug.users.map((u) => (
            <span key={u} className="pill user-pill">
              {u}
            </span>
          ))}
        </p>
      )}
      <div className="actions">
        {bug.status === "new" && (
          <button type="button" className="btn sm" onClick={() => void act("status", { status: "confirmed" }, "Bug confirmado")}>
            Confirmar
          </button>
        )}
        {open && !asking && (
          <button type="button" className="btn sm" onClick={() => setAsking(true)}>
            Falso positivo
          </button>
        )}
        <button type="button" className="btn sm primary" onClick={() => void act("reproduce", undefined, "Reprodução iniciada")}>
          Reproduzir
        </button>
      </div>
      {asking && (
        <div className="reason">
          <label>
            Motivo
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn sm"
            disabled={!reason.trim()}
            onClick={() => void act("status", { status: "false_positive", reason: reason.trim() }, "Marcado como falso positivo")}
          >
            Confirmar falso positivo
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
