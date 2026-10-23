import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type CapabilityResponse } from "../api";
import { Icon } from "../icons";
import { EmptyState, PageHeader, Skeleton, useToast } from "../ui";
import { useWorkspace } from "../workspace";

const CRIT: Record<string, string> = { critical: "crítica", high: "alta", normal: "normal" };
const STATUS: Record<string, string> = { pass: "passou", fail: "falhou", error: "erro", skipped: "pulada", untested: "não testada" };

export function ProductPage() {
  const ws = useWorkspace();
  const toast = useToast();
  const qc = useQueryClient();

  const caps = useQuery({
    queryKey: ["capabilities", ws.env?.id, ws.graph.data?.graph.id],
    queryFn: () => api<CapabilityResponse>(`/api/v1/environments/${ws.env?.id}/capabilities`, ws.token),
    enabled: !!ws.env && !!ws.graph.data,
  });

  async function regenerate() {
    if (!ws.env) return;
    const working = toast.loading("Recalculando capacidades…", "Agrupando as telas do mapa em capacidades de produto.");
    try {
      await api<CapabilityResponse>(`/api/v1/environments/${ws.env.id}/capabilities`, ws.token, { method: "POST", body: JSON.stringify({}) });
      await qc.invalidateQueries({ queryKey: ["capabilities", ws.env.id] });
      working.done("Capacidades atualizadas");
    } catch (e) {
      working.fail("Não foi possível recalcular", errorMessage(e));
    }
  }

  return (
    <div className="page">
      <PageHeader title="Produto" subtitle="Capacidades de negócio inferidas a partir do mapa explorado.">
        <div className="inline-actions">
          <button type="button" className="btn" onClick={() => ws.go("map")}>
            <Icon name="node" size={16} /> Ver mapa técnico
          </button>
          <button type="button" className="btn" onClick={() => void regenerate()} disabled={!ws.env || !ws.graph.data}>
            <Icon name="sparkles" size={16} /> Recalcular capacidades
          </button>
        </div>
      </PageHeader>

      {!ws.env || !ws.graph.data ? (
        <section className="card">
          <EmptyState icon="flow" title="Ainda não há mapa para agrupar" text="Rode uma exploração para gerar o mapa e calcular capacidades." />
        </section>
      ) : caps.isPending ? (
        <section className="card">
          <div className="skeleton-rows">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={88} radius={14} />
            ))}
          </div>
        </section>
      ) : (caps.data?.capabilities.length ?? 0) === 0 ? (
        <section className="card">
          <EmptyState icon="node" title="Nenhuma capacidade detectada" text="Este mapa ainda não tem telas de página suficientes para agrupamento." />
        </section>
      ) : (
        <section className="card">
          <ul className="rows-plain">
            {(caps.data?.capabilities ?? []).map((c) => (
              <li key={c.id}>
                <span className="row-main">
                  <strong>{c.name}</strong>
                  <span className="meta">{c.description}</span>
                  <span className="flow-tags">
                    <span className={`pill sev-${c.criticality}`}>criticidade {CRIT[c.criticality] ?? c.criticality}</span>
                    <span className="pill">{c.nodes_total} tela(s)</span>
                    <span className="pill">{c.nodes_covered} coberta(s)</span>
                    <span className="pill">{c.nodes_tested} testada(s)</span>
                    <span className="pill">status: {STATUS[c.status] ?? c.status}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
