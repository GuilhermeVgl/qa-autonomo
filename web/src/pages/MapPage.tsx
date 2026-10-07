import { useMemo, useState } from "react";
import type { GraphNode } from "../api";
import { BugCard, NodeHistory, PendencyCard, ReportCard } from "../cards";
import { AccessMatrix } from "../AccessMatrix";
import { graphOfUser } from "../access";
import { NodeKnowledge } from "../NodeKnowledge";
import { GraphView } from "../GraphView";
import { Icon } from "../icons";
import { RunProgress } from "../progress";
import { Segmented, Skeleton } from "../ui";
import { useWorkspace } from "../workspace";

export function MapPage() {
  const ws = useWorkspace();
  const { graph, activeRun, report, bugs, openPendencies, discoveries, token } = ws;
  const [selected, setSelected] = useState<GraphNode>();
  const [view, setView] = useState<"graph" | "access">("graph");
  const [user, setUser] = useState("");
  const users = useMemo(() => [...new Set((graph.data?.nodes ?? []).flatMap((n) => n.app_roles))].sort(), [graph.data]);
  const shownGraph = useMemo(() => (graph.data ? graphOfUser(graph.data, users.includes(user) ? user : "") : undefined), [graph.data, user, users]);
  const dockOpen = !!activeRun || !!report || (bugs?.length ?? 0) > 0 || openPendencies.length > 0;

  let body;
  if (!ws.projects.isPending && !ws.project) {
    body = (
      <div className="empty">
        <span className="empty-orbs" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p>Crie um projeto para começar.</p>
        <button type="button" className="btn primary" onClick={() => ws.go("settings", "projetos")}>
          Criar projeto
        </button>
      </div>
    );
  } else if (ws.project && !ws.envs.isPending && !ws.env) {
    body = (
      <div className="empty">
        <span className="empty-orbs" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p>Cadastre o ambiente da aplicação que será testada.</p>
        <button type="button" className="btn primary" onClick={() => ws.go("settings", "ambientes")}>
          Criar ambiente
        </button>
      </div>
    );
  } else if (graph.data && graph.data.nodes.length > 0) {
    body = (
      <>
        <div className="map-bar">
          <Segmented<"graph" | "access">
            label="Visão do mapa"
            value={view}
            onChange={setView}
            options={[
              { value: "graph", label: "Grafo" },
              { value: "access", label: "Acesso por usuário" },
            ]}
          />
          {view === "graph" && users.length > 1 && (
            <label className="map-user">
              Ver como{" "}
              <select value={users.includes(user) ? user : ""} onChange={(e) => setUser(e.target.value)} aria-label="Ver o mapa como">
                <option value="">todos os usuários</option>
                {users.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {view === "graph" && shownGraph ? (
          <GraphView
            graph={shownGraph}
            coverage={ws.nodeCoverage}
            results={ws.nodeResults}
            selectedId={selected?.id}
            reserveRight={dockOpen}
            live={activeRun?.type === "exploration"}
            freshIds={discoveries.freshIds}
            onSelect={setSelected}
          />
        ) : (
          <div className={`access-pane${dockOpen ? " reserve" : ""}`}>
            <AccessMatrix nodes={graph.data.nodes} coverage={ws.nodeCoverage} results={ws.nodeResults} onSelect={setSelected} />
          </div>
        )}
      </>
    );
  } else if (graph.isPending && ws.env) {
    body = (
      <div className="empty" aria-busy="true">
        <Skeleton width={220} height={14} />
        <Skeleton width={160} height={14} />
      </div>
    );
  } else {
    const exploring = activeRun?.type === "exploration";
    body = (
      <div className="empty">
        <span className={`empty-orbs${activeRun ? " is-working" : ""}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p>{exploring ? "Mapeando… as telas vão aparecer aqui assim que forem descobertas." : "Nenhum grafo ainda. Inicie uma exploração."}</p>
        {!activeRun && ws.env && !ws.env.is_production && (
          <button type="button" className="btn primary" onClick={() => ws.openRunDialog("exploration")}>
            <Icon name="explore" size={16} /> Iniciar mapeamento
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="canvas">
      {body}
      <div className="dock">
        {activeRun && <RunProgress run={activeRun} nodes={graph.data?.nodes.length ?? 0} edges={graph.data?.edges.length ?? 0} items={discoveries.items} />}
        {selected && (
          <aside aria-label="Detalhes do nó" className="card">
            <div className="card-head">
              <h2>{selected.label}</h2>
              <button type="button" className="icon-btn" aria-label="Fechar detalhes" onClick={() => setSelected(undefined)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="meta">Papel: {selected.app_roles.join(", ") || "—"}</p>
            <NodeKnowledge node={selected} />
            <NodeHistory nodeId={selected.id} token={token} />
            <details>
              <summary>Metadados</summary>
              <pre>{JSON.stringify(selected.metadata, null, 2)}</pre>
            </details>
          </aside>
        )}
        {report && <ReportCard report={report} />}
        {(bugs?.length ?? 0) > 0 && (
          <section aria-label="Bugs" className="card bugs">
            <div className="card-head">
              <h2>
                <Icon name="bug" size={18} /> Bugs ({bugs?.length})
              </h2>
            </div>
            {bugs?.slice(0, 3).map((b) => (
              <BugCard key={b.id} bug={b} token={token} onDone={ws.refreshBugs} />
            ))}
            {(bugs?.length ?? 0) > 3 && (
              <button type="button" className="link-btn" onClick={() => ws.go("bugs")}>
                Ver todos os {bugs?.length} bugs →
              </button>
            )}
          </section>
        )}
        {openPendencies.length > 0 && graph.data && (
          <section aria-label="Pendências" className="card pendencies">
            <div className="card-head">
              <h2>
                <Icon name="question" size={18} /> Pendências ({openPendencies.length})
              </h2>
            </div>
            {openPendencies.map((p) => (
              <PendencyCard key={p.id} pendency={p} nodes={graph.data?.nodes ?? []} token={token} onDone={ws.refreshCoverage} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
