import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type Coverage, type RunStep } from "../api";
import { NodeHistory } from "../cards";
import { FlowChart } from "../FlowChart";
import { boxFocus, boxPossibilities, boxTones, buildModel, detectJourneys, layoutFlow, requirementFlows, runFlow, screenDifferences, type Box, type Flow, type FlowOrigin } from "../flows";
import { Icon } from "../icons";
import { roleColor } from "../roles";
import { Picture, primaryNode, userLabel } from "../ScreenCard";
import { TONE_LABEL, type Tone } from "../tone";
import { EmptyState, PageHeader, Segmented, Skeleton } from "../ui";
import { plural, runTypeLabel } from "../format";
import { useWorkspace } from "../workspace";

const ORIGINS: { value: FlowOrigin; label: string }[] = [
  { value: "journey", label: "Jornadas" },
  { value: "requirement", label: "Requisitos" },
  { value: "run", label: "Execução" },
];

const HINT: Record<FlowOrigin, string> = {
  journey: "Histórias que o agente encontrou: o que dá para abrir, enviar, buscar ou chamar a partir de cada tela.",
  requirement: "As telas ligadas a um requisito e o que se faz a partir delas.",
  run: "O que uma regressão testou, com o resultado de cada tela naquela execução.",
};

const LEGEND: Tone[] = ["passed", "failing", "skipped", "covered", "no_spec"];

export function FlowsPage() {
  const ws = useWorkspace();
  const graph = ws.graph.data;
  const [origin, setOrigin] = useState<FlowOrigin>("journey");
  const [search, setSearch] = useState("");
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [onlyUncovered, setOnlyUncovered] = useState(false);
  const [pickedId, setPickedId] = useState<string>();
  const [box, setBox] = useState<Box>();
  const [specId, setSpecId] = useState<string>();
  const [runId, setRunId] = useState<string>();

  const model = useMemo(() => (graph ? buildModel(graph) : undefined), [graph]);
  const journeys = useMemo(() => (model ? detectJourneys(model) : []), [model]);

  const specs = ws.specs ?? [];
  const spec = specs.find((s) => s.id === specId) ?? specs.find((s) => s.source_type !== "auto") ?? specs[0];
  const coverage = useQuery({
    queryKey: ["coverage", spec?.id, graph?.graph.id],
    queryFn: () => api<Coverage>(`/api/v1/specs/${spec?.id}/coverage?graph_id=${graph?.graph.id}`, ws.token),
    enabled: origin === "requirement" && !!spec && !!graph,
  }).data;
  const reqFlows = useMemo(() => (model && coverage ? requirementFlows(model, coverage.requirements) : []), [model, coverage]);

  const finishedRuns = (ws.runs.data ?? []).filter((r) => r.type === "regression" && (r.status === "succeeded" || r.status === "failed"));
  const run = finishedRuns.find((r) => r.id === runId) ?? finishedRuns[0];
  // the worst result of each node, not every step: a big run has thousands
  const steps = useQuery({
    queryKey: ["run-node-results", run?.id],
    queryFn: () => api<Pick<RunStep, "node_id" | "result">[]>(`/api/v1/runs/${run?.id}/node-results`, ws.token),
    enabled: origin === "run" && !!run,
  }).data;
  const runFlows = useMemo(() => {
    if (!model || !steps || !run) return [];
    const who = run.budget?.roles && run.budget.roles.length > 0 ? `como ${run.budget.roles.join(", ")}` : "todos os usuários";
    const f = runFlow(model, steps, `${runTypeLabel(run.type)} de ${new Date(run.created_at ?? run.started_at ?? Date.now()).toLocaleString("pt-BR")}`, who);
    return f ? [f] : [];
  }, [model, steps, run]);

  const all: Flow[] = origin === "journey" ? journeys : origin === "requirement" ? reqFlows : runFlows;
  const q = search.trim().toLowerCase();
  const flows = all.filter((f) => (!onlyDifferent || f.partial > 0 || hasDifferences(model, f)) && (!onlyUncovered || f.uncovered.length > 0) && (q === "" || `${f.title} ${f.subtitle}`.toLowerCase().includes(q)));
  const selected = flows.find((f) => f.id === pickedId) ?? flows[0];
  const hasPictures = !!graph?.nodes.some((n) => n.has_thumbnail);
  const layout = useMemo(() => (model && selected ? layoutFlow(model, selected) : undefined), [model, selected]);
  const focus = useMemo(() => (layout && selected ? boxFocus(layout, selected.results ?? ws.nodeResults) : {}), [layout, selected, ws.nodeResults]);
  const tones = useMemo(() => (layout && selected ? boxTones(layout, selected.results ?? ws.nodeResults, ws.nodeCoverage) : {}), [layout, selected, ws.nodeResults, ws.nodeCoverage]);
  const possibilities = useMemo(() => {
    if (!layout || !selected) return {};
    const out: Record<string, ReturnType<typeof boxPossibilities>> = {};
    for (const b of layout.boxes) out[b.id] = boxPossibilities(b, selected.results ?? ws.nodeResults);
    return out;
  }, [layout, selected, ws.nodeResults]);

  const header = <PageHeader title="Fluxos" subtitle="Cada fluxo mostra as telas por onde se passa, uma raia por usuário. A mesma tela com permissões diferentes aparece lado a lado." />;

  if (!ws.env || !graph || graph.nodes.length === 0 || !model) {
    return (
      <div className="page">
        {header}
        <section className="card">
          <EmptyState icon="flow" title="Ainda não há mapa para mostrar" text="Explore a aplicação: os fluxos nascem do que o agente encontra, com a imagem de cada tela.">
            <button type="button" className="btn primary" onClick={() => ws.openRunDialog("exploration")} disabled={!ws.env || ws.env.is_production}>
              <Icon name="explore" size={16} /> Nova exploração
            </button>
          </EmptyState>
        </section>
      </div>
    );
  }

  return (
    <div className="flows">
      <aside className="card flow-list" aria-label="Lista de fluxos">
        <Segmented<FlowOrigin> label="Origem dos fluxos" value={origin} onChange={(o) => (setOrigin(o), setPickedId(undefined), setBox(undefined))} options={ORIGINS} />
        <p className="meta">{HINT[origin]}</p>

        {origin === "requirement" && specs.length > 0 && (
          <label className="flow-pick">
            Especificação
            <select value={spec?.id ?? ""} onChange={(e) => (setSpecId(e.target.value), setPickedId(undefined))} aria-label="Especificação">
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {origin === "run" && finishedRuns.length > 0 && (
          <label className="flow-pick">
            Execução
            <select value={run?.id ?? ""} onChange={(e) => (setRunId(e.target.value), setPickedId(undefined))} aria-label="Execução">
              {finishedRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.created_at ?? r.started_at ?? Date.now()).toLocaleString("pt-BR")} · {r.status === "failed" ? "falhou" : "concluída"}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flow-filters">
          <label className="search">
            <Icon name="search" size={16} />
            <input aria-label="Buscar fluxos" placeholder="Buscar fluxo" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={onlyDifferent} onChange={(e) => setOnlyDifferent(e.target.checked)} />
            <span>Só com permissões diferentes</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={onlyUncovered} onChange={(e) => setOnlyUncovered(e.target.checked)} />
            <span>Só com tela sem requisito</span>
          </label>
        </div>

        {origin === "requirement" && !coverage ? (
          <Skeleton height={44} radius={12} />
        ) : origin === "run" && finishedRuns.length === 0 ? (
          <p className="meta">Nenhuma regressão concluída ainda.</p>
        ) : flows.length === 0 ? (
          <p className="meta">
            {origin === "run" && steps ? "Esta execução testou telas de uma versão antiga do mapa." : "Nenhum fluxo encontrado. Explore com ações no navegador (orçamento de ações maior que zero) para o agente achar formulários e janelas."}
          </p>
        ) : (
          <ul className="rows-plain">
            {flows.map((f) => (
              <li key={f.id}>
                <button type="button" className={`flow-item${f.id === selected?.id ? " on" : ""}`} onClick={() => (setPickedId(f.id), setBox(undefined))} aria-pressed={f.id === selected?.id}>
                  <strong className="clip">{f.title}</strong>
                  <span className="meta clip">{f.subtitle}</span>
                  <span className="flow-tags">
                    <span className="pill">{plural(f.screens.length, "tela", "telas")}</span>
                    {f.users.map((u) => (
                      <span key={u} className="user-chip sm" style={{ background: roleColor(u) }}>
                        {userLabel(u)}
                      </span>
                    ))}
                    {f.partial > 0 && <span className="pill status-reopened">{f.partial} com acesso diferente</span>}
                    {f.uncovered.length > 0 && <span className="pill status-reopened" title={`Sem requisito: ${f.uncovered.join(", ").replaceAll("page|", "")}`}>{plural(f.uncovered.length, "tela sem requisito", "telas sem requisito")}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="card flow-canvas" aria-label="Fluxograma">
        {selected && layout ? (
          <>
            <div className="flow-bar">
              <div className="row-main">
                <strong className="clip">{selected.title}</strong>
                <span className="meta clip">{selected.subtitle}</span>
              </div>
              <div className="flow-legend" aria-label="Legenda">
                {LEGEND.map((t) => (
                  <span key={t} className="legend-item">
                    <i className={`dot tone-${t}`} /> {TONE_LABEL[t]}
                  </span>
                ))}
                <span className="legend-item">
                  <Icon name="lock" size={12} /> sem acesso
                </span>
              </div>
            </div>
            {!hasPictures && <p className="meta flow-note">As imagens das telas aparecem a partir da próxima exploração.</p>}
            <div className="flow-stage">
              <FlowChart layout={layout} flowId={selected.id} tones={tones} focus={focus} possibilities={possibilities} token={ws.token} selectedBox={box?.id} onSelect={setBox} />
            </div>
            {box && <BoxDetail box={box} tone={tones[box.id] ?? "neutral"} focusId={focus[box.id]} possibilities={possibilities[box.id] ?? []} onClose={() => setBox(undefined)} />}
          </>
        ) : (
          <EmptyState icon="flow" title="Escolha um fluxo" text="A lista ao lado mostra o que o agente encontrou." />
        )}
      </section>
    </div>
  );
}

function hasDifferences(model: ReturnType<typeof buildModel> | undefined, f: Flow): boolean {
  if (!model) return false;
  return f.screens.some((k) => {
    const s = model.screens.get(k);
    return !!s && Object.keys(screenDifferences(s)).length > 0;
  });
}

/** The selected screen up close: a larger picture, what it is for this user, what only this user has, and its history. */
function BoxDetail({ box, tone, focusId, possibilities, onClose }: { box: Box; tone: Tone; focusId: string | undefined; possibilities: ReturnType<typeof boxPossibilities>; onClose: () => void }) {
  const ws = useWorkspace();
  const node = primaryNode(box.nodes, focusId);
  const others = Object.keys(box.screen.cells).filter((u) => u !== box.user);
  const diffs = screenDifferences(box.screen);
  return (
    <aside className="flow-detail card" aria-label="Detalhes da tela">
      <div className="card-head">
        <h2 className="clip">{box.screen.route}</h2>
        <button type="button" className="icon-btn" aria-label="Fechar detalhes" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {box.ghost ? (
        <p>
          <Icon name="lock" size={14} /> {userLabel(box.user)} não alcançou esta tela na exploração. {others.length > 0 ? `Quem alcança: ${others.map(userLabel).join(", ")}.` : ""}
        </p>
      ) : (
        <>
          {box.screen.kind !== "endpoint" && <Picture node={node} token={ws.token} />}
          <p className="meta">
            Como <strong>{userLabel(box.user)}</strong> · {TONE_LABEL[tone]}
          </p>
          {box.screen.kind === "page" && (
            <p>
              {box.screen.requirements.length > 0 ? (
                <>
                  Especificada por:{" "}
                  {box.screen.requirements.map((k) => (
                    <span key={k} className="pill">
                      {k}
                    </span>
                  ))}
                </>
              ) : (
                <span className="meta">Nenhum requisito cobre esta tela: o que ela faz não está especificado.</span>
              )}
            </p>
          )}
          {box.only.length > 0 && (
            <p>
              Só {userLabel(box.user)} tem: <strong>{box.only.join(", ")}</strong>
            </p>
          )}
          {Object.entries(diffs)
            .filter(([u]) => u !== box.user)
            .map(([u, list]) => (
              <p key={u} className="meta">
                Só {userLabel(u)} tem: {list.join(", ")}
              </p>
            ))}
          {possibilities.length > 0 && (
            <div>
              <h3>Possibilidades desta tela</h3>
              <ul className="rows-plain">
                {possibilities.map((p) => (
                  <li key={p.id}>
                    <span className={`dot tone-${p.result === "untested" ? "covered" : p.result === "pass" ? "passed" : p.result === "skipped" ? "skipped" : "failing"}`} />
                    <span>{p.label}</span>
                    <span className="meta">{p.result === "untested" ? "não testado" : p.result === "pass" ? "passou" : p.result === "skipped" ? "pulado" : "falhou"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {node && <NodeHistory nodeId={node.id} token={ws.token} />}
        </>
      )}
    </aside>
  );
}
