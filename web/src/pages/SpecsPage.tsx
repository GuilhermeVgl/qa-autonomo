import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, type Requirement, type RunReport, type Spec } from "../api";
import { Icon } from "../icons";
import { EmptyState, Modal, PageHeader, Segmented, Skeleton, useToast } from "../ui";
import { useWorkspace } from "../workspace";

type Filter = "all" | Requirement["criticality"];
type CategoryFilter = "business" | "technical";

const CRITICALITY: Record<string, string> = { critical: "crítico", high: "alto", normal: "normal" };
const COVERAGE: Record<string, { label: string; tone: string }> = {
  covered: { label: "Coberto", tone: "ok" },
  pending: { label: "Pendência", tone: "warn" },
  unmatched: { label: "Sem tela", tone: "idle" },
};
const OUTCOME: Record<string, { label: string; tone: string }> = {
  pass: { label: "Passou", tone: "ok" },
  fail: { label: "Falhou", tone: "bad" },
  error: { label: "Erro", tone: "bad" },
  skipped: { label: "Pulada", tone: "idle" },
};

const QUALITY_HINT: Record<string, string> = {
  vago: "Tem palavras que nenhum teste decide (adequado, rápido, amigável). Troque por algo que dá para observar.",
  curto: "Diz pouco demais para ser verificado. Escreva quem faz o quê e qual é o resultado.",
  composto: "Tem vários comportamentos num só. Separe em requisitos diferentes para saber qual falhou.",
  parecido: "Diz quase o mesmo que um requisito anterior. Una os dois ou apague um.",
};

const sourceLabel = (s: Spec) => (s.source_type === "openapi" ? "OpenAPI" : s.source_type === "auto" ? "Automática" : "Texto");

const keyCategory = (key: string): CategoryFilter => (/^REQ-\d+$/i.test(key) ? "business" : "technical");
const requirementCategory = (r: Requirement): CategoryFilter => (r.category === "business" || r.category === "technical" ? r.category : keyCategory(r.key));

export function SpecsPage() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const toast = useToast();
  const { specs, spec: latest } = ws;
  const [pickedId, setPickedId] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<CategoryFilter>("business");
  const [editing, setEditing] = useState<Requirement | "new" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<Spec | null>(null);
  const selected = specs?.find((s) => s.id === pickedId) ?? latest ?? specs?.[0];
  const canRun = !!ws.env && !ws.env.is_production && !!ws.graph.data && !ws.activeRun;

  useEffect(() => {
    if (!selected) return;
    if (selected.source_type === "auto" || selected.source_type === "openapi") setCategory("technical");
    else setCategory("business");
  }, [selected?.id, selected?.source_type]);

  const requirements = useQuery({
    queryKey: ["requirements", selected?.id],
    queryFn: () => api<Requirement[]>(`/api/v1/specs/${selected?.id}/requirements`, ws.token),
    enabled: !!selected,
  });
  const graphId = ws.graph.data?.graph.id;
  const coverage = useQuery({
    queryKey: ["coverage", selected?.id, graphId],
    queryFn: () => api<{ requirements: { key: string; status: string }[] }>(`/api/v1/specs/${selected?.id}/coverage?graph_id=${graphId}`, ws.token),
    enabled: !!selected && !!graphId,
  }).data;
  const coverageByKey = useMemo(() => new Map(coverage?.requirements.map((r) => [r.key, r.status]) ?? []), [coverage]);

  // the last finished regression that tested this spec (or, failing that, any regression) tells how each requirement did
  const lastRun = ws.runs.data?.find((r) => r.type === "regression" && (r.status === "succeeded" || r.status === "failed") && r.budget?.spec_id === selected?.id);
  const lastReport = useQuery({
    queryKey: ["report", lastRun?.id],
    queryFn: () => api<RunReport>(`/api/v1/runs/${lastRun?.id}/report`, ws.token),
    enabled: !!lastRun,
  }).data;
  const outcomeByKey = useMemo(() => new Map(lastReport?.requirements.map((r) => [r.key, r.outcome]) ?? []), [lastReport]);
  const usersByKey = useMemo(() => new Map(lastReport?.requirements.map((r) => [r.key, r.by_user ?? {}]) ?? []), [lastReport]);

  const rows = (requirements.data ?? []).filter((r) => {
    const cat = requirementCategory(r);
    return cat === category && (filter === "all" || r.criticality === filter) && (search.trim() === "" || `${r.key} ${r.text}`.toLowerCase().includes(search.trim().toLowerCase()));
  });

  const counts = useMemo(() => {
    const out = { business: 0, technical: 0 };
    for (const r of requirements.data ?? []) out[requirementCategory(r)] += 1;
    return out;
  }, [requirements.data]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["specs"] }), qc.invalidateQueries({ queryKey: ["requirements"] }), qc.invalidateQueries({ queryKey: ["coverage"] }), qc.invalidateQueries({ queryKey: ["pendencies"] })]);

  async function removeRequirement(r: Requirement) {
    if (!r.id || !window.confirm(`Excluir o requisito ${r.key}? As ligações com telas e as pendências dele também saem; os bugs ficam.`)) return;
    try {
      await api(`/api/v1/requirements/${r.id}`, ws.token, { method: "DELETE" });
      await refresh();
      toast.show({ kind: "success", title: `Requisito ${r.key} excluído` });
    } catch (e) {
      toast.show({ kind: "error", title: "Não foi possível excluir", text: errorMessage(e) });
    }
  }

  const headerActions = (
    <>
      <button type="button" className="btn" onClick={() => void ws.generateAutoSpec()} disabled={!ws.env || !ws.graph.data} title="Cria ou atualiza a especificação que descreve cada tela e formulário mapeados">
        <Icon name="sparkles" size={16} /> {specs?.some((s) => s.source_type === "auto") ? "Atualizar varredura automática" : "Gerar spec automática"}
      </button>
      <button type="button" className="btn primary" onClick={() => ws.setSpecDialogOpen(true)} disabled={!ws.project}>
        <Icon name="plus" size={16} /> Nova especificação
      </button>
    </>
  );

  if (specs && specs.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Especificações" subtitle="Os requisitos que o agente vai testar.">
          {headerActions}
        </PageHeader>
        <section className="card">
          <EmptyState icon="file" title="Nenhuma especificação ainda" text="Envie um texto com as regras do produto ou um contrato OpenAPI. Ou explore a aplicação e gere a especificação automática: um requisito por tela e formulário.">
            <button type="button" className="btn primary" onClick={() => ws.setSpecDialogOpen(true)} disabled={!ws.project}>
              <Icon name="plus" size={16} /> Nova especificação
            </button>
          </EmptyState>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Especificações" subtitle="Os requisitos que o agente vai testar. Cada especificação pode ser executada sozinha.">
        {headerActions}
      </PageHeader>

      <div className="specs-layout">
        <aside className="card versions" aria-label="Especificações do projeto">
          <h3>Especificações</h3>
          {!specs ? (
            <Skeleton height={44} radius={12} />
          ) : (
            <ul className="rows-plain">
              {specs.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`version${s.id === selected?.id ? " on" : ""}`} onClick={() => setPickedId(s.id)} aria-pressed={s.id === selected?.id}>
                    <span className="version-n">v{s.version}</span>
                    <span className="row-main">
                      <strong className="clip">{s.title}</strong>
                      <span className="meta">{sourceLabel(s)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="card" aria-label="Requisitos">
          {selected && (
            <div className="spec-head">
              <div className="row-main">
                <h2 className="clip">{selected.title}</h2>
                <span className="meta">
                  v{selected.version} · {sourceLabel(selected)}
                  {selected.source_type === "auto" ? " · gerada a partir do mapa" : ""}
                </span>
              </div>
              <div className="spec-actions">
                <button type="button" className="btn primary sm" onClick={() => ws.openRunDialog("regression", selected.id)} disabled={!canRun} title={canRun ? "Executa só os requisitos desta especificação" : "Precisa de um mapa, e nenhum run pode estar ativo"}>
                  <Icon name="play" size={14} /> Rodar esta spec
                </button>
                {selected.source_type !== "auto" && (
                  <button type="button" className="btn sm" onClick={() => void ws.runCrossref(selected.id)} disabled={!ws.env || !ws.graph.data || ws.crossrefBusy}>
                    <Icon name="link" size={14} /> Cruzar com o mapa
                  </button>
                )}
                <button type="button" className="btn sm" onClick={() => setRenaming(true)}>
                  <Icon name="edit" size={14} /> Renomear
                </button>
                <button type="button" className="btn sm danger" onClick={() => setDeleting(selected)}>
                  <Icon name="trash" size={14} /> Excluir
                </button>
              </div>
            </div>
          )}

          <div className="toolbar">
            <label className="search">
              <Icon name="search" size={16} />
              <input aria-label="Buscar requisitos" placeholder="Buscar por chave ou texto" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <Segmented
              label="Tipo"
              value={category}
              onChange={setCategory}
              options={[
                { value: "business", label: `Requisitos (${counts.business})` },
                { value: "technical", label: `Verificações automáticas (${counts.technical})` },
              ]}
            />
            <Segmented
              label="Criticidade"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "Todos" },
                { value: "critical", label: "Críticos" },
                { value: "high", label: "Altos" },
                { value: "normal", label: "Normais" },
              ]}
            />
            <button type="button" className="btn sm" onClick={() => setEditing("new")} disabled={!selected}>
              <Icon name="plus" size={14} /> Requisito
            </button>
          </div>

          {requirements.isPending ? (
            <div className="skeleton-rows">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={38} radius={10} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon="search"
              title={category === "business" ? "Nenhum requisito encontrado" : "Nenhuma verificação automática encontrada"}
              text={category === "business" ? "Ajuste a busca ou o filtro de criticidade." : "Esta especificação não tem verificações automáticas nesta busca."}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Chave</th>
                  <th>Requisito</th>
                  <th>Criticidade</th>
                  {coverageByKey.size > 0 && <th>Cobertura</th>}
                  {outcomeByKey.size > 0 && <th>Último resultado</th>}
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cov = COVERAGE[coverageByKey.get(r.key) ?? ""];
                  const out = OUTCOME[outcomeByKey.get(r.key) ?? ""];
                  return (
                    <tr key={r.id ?? r.key}>
                      <td>
                        <code>{r.key}</code>
                      </td>
                      <td>
                        {r.text}
                        {category === "business" && selected?.source_type !== "auto" && r.status === "new" && <span className="pill status-new"> novo</span>}
                        {category === "business" && selected?.source_type !== "auto" && r.status === "changed" && <span className="pill status-reopened"> alterado</span>}
                        {category === "business" && (r.quality ?? []).length > 0 && (
                          <span className="quality-flags" aria-label={`Revisar ${r.key}`}>
                            {(r.quality ?? []).map((q) => (
                              <span key={q} className="pill status-reopened" title={QUALITY_HINT[q.split(" ")[0] ?? ""] ?? "Revise este requisito"}>
                                revisar: {q}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`pill sev-${r.criticality}`}>{CRITICALITY[r.criticality] ?? r.criticality}</span>
                      </td>
                      {coverageByKey.size > 0 && <td>{cov ? <span className={`chip tone-${cov.tone}`}>{cov.label}</span> : "—"}</td>}
                      {outcomeByKey.size > 0 && <td>{out ? <OutcomeCell outcome={out} byUser={usersByKey.get(r.key) ?? {}} /> : "—"}</td>}
                      <td className="row-actions">
                        <button type="button" className="icon-btn" aria-label={`Editar ${r.key}`} title="Editar" onClick={() => setEditing(r)} disabled={!r.id}>
                          <Icon name="edit" size={16} />
                        </button>
                        <button type="button" className="icon-btn" aria-label={`Excluir ${r.key}`} title="Excluir" onClick={() => void removeRequirement(r)} disabled={!r.id}>
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {lastRun && <p className="meta">Resultados da última execução desta especificação. O que cada checagem digitou e recebeu está em Execuções.</p>}
        </section>
      </div>

      {editing && selected && (
        <RequirementDialog
          specId={selected.id}
          requirement={editing === "new" ? null : editing}
          token={ws.token}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {renaming && selected && (
        <RenameDialog
          spec={selected}
          token={ws.token}
          onClose={() => setRenaming(false)}
          onSaved={async () => {
            setRenaming(false);
            await refresh();
          }}
        />
      )}
      {deleting && (
        <Modal title="Excluir especificação" subtitle={deleting.title} onClose={() => setDeleting(null)}>
          <div className="modal-body">
          <p>Os requisitos, as ligações com telas e as pendências desta especificação saem. Os bugs já encontrados ficam, só deixam de apontar para um requisito.</p>
          <footer className="modal-foot">
            <button type="button" className="btn" onClick={() => setDeleting(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                try {
                  await api(`/api/v1/specs/${deleting.id}`, ws.token, { method: "DELETE" });
                  setDeleting(null);
                  setPickedId(undefined);
                  await refresh();
                  toast.show({ kind: "success", title: "Especificação excluída" });
                } catch (e) {
                  toast.show({ kind: "error", title: "Não foi possível excluir", text: errorMessage(e) });
                }
              }}
            >
              Excluir especificação
            </button>
          </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The verdict of a requirement, and, when more than one user was tested, how each of them did. */
function OutcomeCell({ outcome, byUser }: { outcome: { label: string; tone: string }; byUser: Record<string, string> }) {
  const users = Object.entries(byUser).filter(([u]) => u !== "");
  return (
    <>
      <span className={`chip tone-${outcome.tone}`}>{outcome.label}</span>
      {users.length > 1 && (
        <span className="by-user" aria-label="Resultado por usuário">
          {users.map(([u, o]) => (
            <span key={u} className={`pill user-pill result-${o}`} title={`${u}: ${OUTCOME[o]?.label ?? o}`}>
              {u}: {OUTCOME[o]?.label.toLowerCase() ?? o}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function RenameDialog({ spec, token, onClose, onSaved }: { spec: Spec; token: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState(spec.title);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/v1/specs/${spec.id}`, token, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      await onSaved();
    } catch (err) {
      toast.show({ kind: "error", title: "Não foi possível renomear", text: errorMessage(err) });
    }
  }
  return (
    <Modal title="Renomear especificação" onClose={onClose}>
      <form onSubmit={submit} className="modal-body">
        <label>
          Nome
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </label>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={title.trim() === ""}>
            Salvar
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function RequirementDialog({
  specId,
  requirement,
  token,
  onClose,
  onSaved,
}: {
  specId: string;
  requirement: Requirement | null;
  token: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [text, setText] = useState(requirement?.text ?? "");
  const [criticality, setCriticality] = useState<Requirement["criticality"]>(requirement?.criticality ?? "normal");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (requirement?.id) await api(`/api/v1/requirements/${requirement.id}`, token, { method: "PATCH", body: JSON.stringify({ text: text.trim(), criticality }) });
      else await api(`/api/v1/specs/${specId}/requirements`, token, { method: "POST", body: JSON.stringify({ text: text.trim(), criticality }) });
      await onSaved();
    } catch (err) {
      toast.show({ kind: "error", title: "Não foi possível salvar o requisito", text: errorMessage(err) });
    }
  }
  return (
    <Modal title={requirement ? `Editar ${requirement.key}` : "Novo requisito"} onClose={onClose}>
      <form onSubmit={submit} className="modal-body">
        <label>
          Texto
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} required autoFocus />
        </label>
        <label>
          Criticidade
          <select value={criticality} onChange={(e) => setCriticality(e.target.value as Requirement["criticality"])}>
            <option value="critical">Crítico</option>
            <option value="high">Alto</option>
            <option value="normal">Normal</option>
          </select>
        </label>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={text.trim() === ""}>
            Salvar
          </button>
        </footer>
      </form>
    </Modal>
  );
}
