import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Run, type RunReport } from "../api";
import { plural, runDuration, runTypeLabel, timeAgo, triggerLabel } from "../format";
import { blockedOf } from "../blocked";
import { Icon } from "../icons";
import { resumableExploration } from "../resume";
import { EmptyState, PageHeader, Skeleton } from "../ui";
import { useWorkspace } from "../workspace";
import { RunStatus } from "./Overview";
import { RunSteps } from "../cards";

function RunDetail({ run }: { run: Run }) {
  const ws = useWorkspace();
  const finished = run.status === "succeeded" || run.status === "failed";
  const report = useQuery({
    queryKey: ["report", run.id],
    queryFn: () => api<RunReport>(`/api/v1/runs/${run.id}/report`, ws.token),
    enabled: finished,
  }).data;
  const active = run.status === "queued" || run.status === "running";
  const summary = run.summary as {
    pages?: number;
    stopped_by?: string;
    error?: string;
    by_role?: Record<string, { pages: number; login_ok: boolean }>;
    login_failures?: string[];
  };
  const blocked = blockedOf(run);
  // the summary of a regression has another shape under the same name: only an exploration says what each user reached
  const explored = run.type === "exploration" ? Object.entries(summary.by_role ?? {}) : [];

  return (
    <section className="card run-detail" aria-label="Detalhes da execução">
      <div className="card-head">
        <h2>
          {runTypeLabel(run.type)} <RunStatus run={run} />
        </h2>
        {active && (
          <button type="button" className="btn sm danger" onClick={() => void ws.cancelRun(run.id)}>
            <Icon name="stop" size={14} /> Cancelar
          </button>
        )}
        {!ws.activeRun && resumableExploration(ws.runs.data)?.id === run.id && (
          <button type="button" className="btn sm primary" onClick={() => ws.openRunDialog("exploration", undefined, { resume: true })} disabled={!ws.env || ws.env.is_production}>
            <Icon name="explore" size={14} /> Continuar exploração
          </button>
        )}
      </div>
      <dl className="facts">
        <div>
          <dt>Gatilho</dt>
          <dd>{triggerLabel(run.trigger)}</dd>
        </div>
        {run.type === "regression" && (
          <div>
            <dt>Testado como</dt>
            <dd>{run.budget?.roles && run.budget.roles.length > 0 ? run.budget.roles.join(", ") : "todos os usuários"}</dd>
          </div>
        )}
        {run.type === "exploration" && run.budget?.roles && run.budget.roles.length > 0 && (
          <div>
            <dt>Explorado como</dt>
            <dd>{run.budget.roles.join(", ")}</dd>
          </div>
        )}
        {run.budget?.resume && (
          <div>
            <dt>Origem</dt>
            <dd>Continuação da exploração anterior, no mesmo mapa</dd>
          </div>
        )}
        {run.budget?.spec_id && (
          <div>
            <dt>Especificação</dt>
            <dd>{ws.specs?.find((s) => s.id === run.budget?.spec_id)?.title ?? "excluída"}</dd>
          </div>
        )}
        <div>
          <dt>Início</dt>
          <dd>{run.started_at ? new Date(run.started_at).toLocaleString("pt-BR") : "—"}</dd>
        </div>
        <div>
          <dt>Duração</dt>
          <dd>{runDuration(run)}</dd>
        </div>
        {summary.pages !== undefined && (
          <div>
            <dt>Telas mapeadas</dt>
            <dd>{summary.pages}</dd>
          </div>
        )}
      </dl>
      {summary.error && <p role="alert">{summary.error}</p>}
      {blocked && !summary.error && <p role="alert">{blocked.message}</p>}
      {blocked?.details && blocked.details.length > 0 && (
        <table className="table compact" aria-label="Usuários que não entraram">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>O que aconteceu</th>
            </tr>
          </thead>
          <tbody>
            {blocked.details.map((d) => (
              <tr key={d.role}>
                <td>{d.role}</td>
                <td>{d.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {explored.length > 0 && (
        <table className="table compact" aria-label="Usuários explorados">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Telas alcançadas</th>
              <th>Login</th>
            </tr>
          </thead>
          <tbody>
            {explored.map(([user, u]) => (
              <tr key={user}>
                <td>{user}</td>
                <td>{u.pages}</td>
                <td>{u.login_ok ? <span className="chip tone-ok">entrou</span> : <span className="chip tone-bad">falhou</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report && (
        <>
          <div className="result-bars">
            <div className="stat-tile ok">
              <strong>{report.steps["pass"] ?? 0}</strong>
              <span>passaram</span>
            </div>
            <div className="stat-tile bad">
              <strong>{(report.steps["fail"] ?? 0) + (report.steps["error"] ?? 0)}</strong>
              <span>falharam</span>
            </div>
            <div className="stat-tile idle">
              <strong>{report.steps["skipped"] ?? 0}</strong>
              <span>puladas</span>
            </div>
          </div>
          {report.users && report.users.length > 0 && (
            <table className="table compact" aria-label="Usuários testados">
              <thead>
                <tr>
                  <th>Usuário testado</th>
                  <th>Passaram</th>
                  <th>Falharam</th>
                  <th>Puladas</th>
                </tr>
              </thead>
              <tbody>
                {report.users.map((u) => (
                  <tr key={u.user}>
                    <td>{u.user || "sem usuário (API, terminal)"}</td>
                    <td>{u.passed}</td>
                    <td>{u.failed + u.errored}</td>
                    <td>{u.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="meta">
            Bugs: {plural(report.bugs.new.length, "novo", "novos")} · {plural(report.bugs.recurring.length, "recorrente", "recorrentes")} · {plural(report.bugs.fixed.length, "corrigido", "corrigidos")}
            {report.cost.llm_calls > 0 && ` · IA: ${report.cost.llm_calls} chamadas, ${report.cost.tokens_in + report.cost.tokens_out} tokens`}
          </p>
        </>
      )}
      {report?.security && report.security.checks > 0 && (
        <section className="run-security" aria-label="Segurança da execução">
          <h3>Segurança</h3>
          <p>
            {plural(report.security.checks, "verificação", "verificações")} · {report.security.failed === 0 ? "nenhuma falha" : `${report.security.failed} com falha`}
          </p>
          {report.security.failed > 0 && (
            <div className="kpi-tags">
              {report.security.by_severity.critical > 0 && <span className="pill sev-critical">{plural(report.security.by_severity.critical, "crítica", "críticas")}</span>}
              {report.security.by_severity.high > 0 && <span className="pill sev-high">{plural(report.security.by_severity.high, "alta", "altas")}</span>}
              {report.security.by_severity.normal > 0 && <span className="pill sev-normal">{plural(report.security.by_severity.normal, "normal", "normais")}</span>}
            </div>
          )}
          <details className="run-steps">
            <summary>Ver as verificações</summary>
            <RunSteps runId={run.id} token={ws.token} users={report.users?.map((u) => u.user) ?? []} kind="security" />
          </details>
        </section>
      )}
      {!active && (
        <details className="run-steps">
          <summary>Checagens e evidências</summary>
          <RunSteps runId={run.id} token={ws.token} users={report?.users?.map((u) => u.user) ?? []} />
        </details>
      )}
    </section>
  );
}

export function RunsPage() {
  const ws = useWorkspace();
  const { runs } = ws;
  const [pickedId, setPickedId] = useState<string>();
  const selected = runs.data?.find((r) => r.id === pickedId) ?? runs.data?.[0];

  return (
    <div className="page">
      <PageHeader title="Execuções" subtitle="Histórico de explorações e regressões deste ambiente." />
      {runs.isPending && ws.env ? (
        <div className="card skeleton-rows">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={44} radius={12} />
          ))}
        </div>
      ) : !runs.data || runs.data.length === 0 ? (
        <section className="card">
          <EmptyState icon="history" title="Nenhuma execução ainda" text="Inicie uma exploração para o agente mapear a aplicação.">
            <button type="button" className="btn primary" onClick={() => ws.openRunDialog("exploration")} disabled={!ws.env || ws.env.is_production}>
              <Icon name="explore" size={16} /> Iniciar mapeamento
            </button>
          </EmptyState>
        </section>
      ) : (
        <div className="runs-layout">
          <section className="card" aria-label="Lista de execuções">
            <table className="table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Status</th>
                  <th>Gatilho</th>
                  <th>Quando</th>
                  <th>Duração</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} className={r.id === selected?.id ? "selected" : ""} onClick={() => setPickedId(r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setPickedId(r.id)}>
                    <td>
                      <span className="row-icon inline">
                        <Icon name={r.type === "exploration" ? "explore" : "repeat"} size={15} />
                      </span>{" "}
                      {runTypeLabel(r.type)}
                    </td>
                    <td>
                      <RunStatus run={r} />
                    </td>
                    <td>{triggerLabel(r.trigger)}</td>
                    <td>{timeAgo(r.created_at)}</td>
                    <td>{runDuration(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {selected && <RunDetail run={selected} />}
        </div>
      )}
    </div>
  );
}
