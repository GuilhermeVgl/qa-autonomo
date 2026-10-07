import { useQuery } from "@tanstack/react-query";
import { api, type Run } from "../api";
import type { BriefResponse } from "../briefReport";
import { blockedOf } from "../blocked";
import { Icon } from "../icons";
import { plural, runDuration, runStatusLabel, runTypeLabel, severityLabel, timeAgo } from "../format";
import { EmptyState, PageHeader, Skeleton } from "../ui";
import { useWorkspace } from "../workspace";

function Donut({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <div className="donut" role="img" aria-label={`${pct}% dos requisitos cobertos`}>
      <svg viewBox="0 0 90 90" width="96" height="96">
        <circle cx="45" cy="45" r={r} className="donut-track" />
        <circle cx="45" cy="45" r={r} className="donut-value" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 45 45)" />
      </svg>
      <strong>{pct}%</strong>
    </div>
  );
}

const SEVERITY_TONE: Record<string, string> = { alta: "bad", média: "warn", baixa: "info" };

const STATUS_TONE: Record<string, string> = { succeeded: "ok", failed: "bad", running: "info", queued: "warn", cancelled: "idle" };

export function RunStatus({ run }: { run: Pick<Run, "status"> & Partial<Pick<Run, "summary">> }) {
  // a run that could not do its job (application down, nobody could log in) did not fail a test: it did not run
  if (run.status === "failed" && blockedOf(run)) return <span className="chip tone-warn">Bloqueada</span>;
  return <span className={`chip tone-${STATUS_TONE[run.status] ?? "idle"}`}>{runStatusLabel(run.status)}</span>;
}

/** What deserves a look, from the same facts the general report is made of: the checks that fail and what does not add up. */
function AttentionCard() {
  const ws = useWorkspace();
  const brief = useQuery({
    queryKey: ["brief-overview", ws.env?.id],
    queryFn: () => api<BriefResponse>(`/api/v1/environments/${ws.env?.id}/brief`, ws.token),
    enabled: !!ws.env,
    staleTime: 20_000,
  });
  const facts = brief.data?.facts;
  const notReady = facts?.readiness.filter((c) => !c.ok) ?? [];
  const issues = facts?.issues.slice(0, 5) ?? [];
  return (
    <section className="card" aria-label="Pontos de atenção">
      <div className="card-head">
        <h2>Pontos de atenção</h2>
        <button type="button" className="link-btn" onClick={() => ws.setReportOpen(true)}>
          Abrir relatório
        </button>
      </div>
      {!ws.env ? (
        <EmptyState icon="check" title="Nada por aqui ainda" text="Crie um ambiente e explore a aplicação para ver o que merece atenção." />
      ) : brief.isPending ? (
        <Skeleton height={60} radius={12} />
      ) : notReady.length === 0 && issues.length === 0 ? (
        <EmptyState icon="check" title="Tudo certo nos fatos" text="O mapa, as especificações e os testes batem entre si." />
      ) : (
        <ul className="rows-plain attention">
          {notReady.map((c) => (
            <li key={c.id}>
              <span className="chip tone-warn">preparar</span>
              <span className="row-main">
                <strong>{c.label}</strong>
                <span className="meta">{c.detail}</span>
              </span>
            </li>
          ))}
          {issues.map((i) => (
            <li key={i.code}>
              <span className={`chip tone-${SEVERITY_TONE[i.severity] ?? "info"}`}>{i.severity}</span>
              <span className="row-main">
                <span>{i.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Overview() {
  const ws = useWorkspace();
  const { coverage, openFunctional: openBugs, openSecurity, openPendencies, runs, report, graph } = ws;
  const name = (ws.me.data?.email ?? "").split("@")[0];
  const lastRun = runs.data?.[0];
  const covered = coverage?.requirements.filter((r) => r.status === "covered").length ?? 0;
  const total = coverage?.requirements.length ?? 0;
  const noSpec = coverage?.nodes.filter((n) => n.status === "no_spec").length ?? 0;
  const sev = (s: string) => openBugs.filter((b) => b.severity === s).length;

  const steps: { title: string; text: string; done: boolean; optional?: boolean; label: string; run: () => void; disabled?: boolean }[] = [
    { title: "Criar um projeto", text: "Cada projeto é uma aplicação a ser testada.", done: (ws.projects.data?.length ?? 0) > 0, label: "Criar projeto", run: () => ws.go("settings", "projetos") },
    {
      title: "Cadastrar um ambiente",
      text: "A URL da aplicação (ou o CLI) e a política de segurança.",
      done: (ws.envs.data?.length ?? 0) > 0,
      label: "Criar ambiente",
      run: () => ws.go("settings", "ambientes"),
      disabled: !ws.project,
    },
    {
      title: "Salvar uma credencial",
      text: "O usuário que o agente usa para entrar. Fica cifrada.",
      done: (ws.credentials?.length ?? 0) > 0,
      optional: true,
      label: "Salvar credencial",
      run: () => ws.go("settings", "credenciais"),
      disabled: !ws.env,
    },
    { title: "Enviar a especificação", text: "Texto ou OpenAPI: o agente extrai os requisitos.", done: (ws.specs?.length ?? 0) > 0, label: "Nova especificação", run: () => ws.setSpecDialogOpen(true), disabled: !ws.project },
    {
      title: "Mapear a aplicação",
      text: "O agente explora sozinho e desenha o grafo ao vivo.",
      done: (graph.data?.nodes.length ?? 0) > 0,
      label: "Iniciar mapeamento",
      run: () => ws.openRunDialog("exploration"),
      disabled: !ws.env || ws.env.is_production,
    },
  ];
  // no flash of "nothing is configured" while the first answers are still on their way
  const loading =
    ws.projects.isPending ||
    (!!ws.project && (ws.envs.isPending || ws.specs === undefined)) ||
    (!!ws.env && (ws.credentials === undefined || graph.isPending));
  const doneCount = steps.filter((s) => s.done).length;
  const firstPending = steps.findIndex((s) => !s.done);

  return (
    <div className="page">
      <PageHeader visibleTitle title={name ? `Olá, ${name}` : "Visão geral"} subtitle={ws.projectName ? "Um resumo do que o agente já encontrou neste ambiente." : "Comece criando um projeto."} />

      {!loading && doneCount < steps.length && (
        <section className="card onboarding" aria-label="Primeiros passos">
          <div className="card-head">
            <h2>
              <Icon name="sparkles" size={18} /> Primeiros passos
            </h2>
            <span className="meta">
              {doneCount} de {steps.length}
            </span>
          </div>
          <div className="bar" role="progressbar" aria-label="Progresso da configuração" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={steps.length}>
            <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? "done" : i === firstPending ? "current" : ""}>
                <span className="step-mark">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="step-text">
                  <strong>
                    {s.title}
                    {s.optional && <small> · opcional</small>}
                  </strong>
                  <span className="meta">{s.text}</span>
                </span>
                {!s.done && (
                  <button type="button" className={`btn sm${i === firstPending ? " primary" : ""}`} onClick={s.run} disabled={s.disabled}>
                    {s.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="kpis">
        <section className="card kpi" aria-label="Cobertura">
          <h3>Cobertura da spec</h3>
          {ws.runs.isPending && ws.env ? (
            <Skeleton height={96} radius={48} width={96} />
          ) : coverage ? (
            <div className="kpi-body">
              <Donut value={covered} total={total} />
              <div>
                <p className="kpi-main">
                  {covered} de {total}
                </p>
                <p className="meta">requisitos cobertos{ws.coverageSpec ? ` em “${ws.coverageSpec.title}”` : ""}</p>
                <p className="meta">{noSpec} {noSpec === 1 ? "tela sem spec" : "telas sem spec"}</p>
              </div>
            </div>
          ) : (
            <p className="meta">Envie uma especificação e mapeie a aplicação para ver a cobertura.</p>
          )}
        </section>

        <section className="card kpi" aria-label="Bugs abertos">
          <h3>Bugs abertos</h3>
          <p className="kpi-main big">{openBugs.length}</p>
          <div className="kpi-tags">
            <span className="pill sev-critical">{plural(sev("critical"), "crítico", "críticos")}</span>
            <span className="pill sev-high">{plural(sev("high"), "alto", "altos")}</span>
            <span className="pill sev-normal">{plural(sev("normal"), "normal", "normais")}</span>
          </div>
          <button type="button" className="link-btn" onClick={() => ws.go("bugs")}>
            Ver bugs →
          </button>
        </section>

        {(openSecurity.length > 0 || report?.security) && (
          <section className="card kpi" aria-label="Segurança aberta">
            <h3>Segurança</h3>
            <p className="kpi-main big">{openSecurity.length}</p>
            <div className="kpi-tags">
              <span className="pill sev-critical">{plural(openSecurity.filter((b) => b.severity === "critical").length, "crítica", "críticas")}</span>
              <span className="pill sev-high">{plural(openSecurity.filter((b) => b.severity === "high").length, "alta", "altas")}</span>
              <span className="pill sev-normal">{plural(openSecurity.filter((b) => b.severity === "normal").length, "normal", "normais")}</span>
            </div>
            <button type="button" className="link-btn" onClick={() => ws.go("bugs")}>
              Ver falhas →
            </button>
          </section>
        )}

        <section className="card kpi" aria-label="Último run">
          <h3>Última execução</h3>
          {lastRun ? (
            <>
              <p className="kpi-main">
                {runTypeLabel(lastRun.type)} <RunStatus run={lastRun} />
              </p>
              <p className="meta">
                {timeAgo(lastRun.finished_at ?? lastRun.started_at ?? lastRun.created_at)} · {runDuration(lastRun)}
              </p>
              {report && report.run.id === lastRun.id && (
                <p className="meta">
                  {report.steps["pass"] ?? 0} passaram · {report.steps["fail"] ?? 0} falharam
                </p>
              )}
            </>
          ) : (
            <p className="meta">Nenhuma execução ainda.</p>
          )}
          <button type="button" className="link-btn" onClick={() => ws.go("runs")}>
            Ver execuções →
          </button>
        </section>

        <section className="card kpi" aria-label="Pendências">
          <h3>Pendências</h3>
          <p className="kpi-main big">{openPendencies.length}</p>
          <p className="meta">{openPendencies.length === 0 ? "Nada esperando resposta." : "Perguntas do agente aguardando você."}</p>
          {openPendencies.length > 0 && (
            <button type="button" className="link-btn" onClick={() => ws.go("map")}>
              Responder no mapa →
            </button>
          )}
        </section>
      </div>

      <div className="two-col">
        <section className="card" aria-label="Execuções recentes">
          <div className="card-head">
            <h2>Execuções recentes</h2>
            <button type="button" className="link-btn" onClick={() => ws.go("runs")}>
              Ver todas
            </button>
          </div>
          {runs.data && runs.data.length > 0 ? (
            <ul className="rows-plain">
              {runs.data.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span className="row-icon">
                    <Icon name={r.type === "exploration" ? "explore" : "repeat"} size={16} />
                  </span>
                  <span className="row-main">
                    <strong>{runTypeLabel(r.type)}</strong>
                    <span className="meta">
                      {timeAgo(r.created_at)} · {runDuration(r)}
                    </span>
                  </span>
                  <RunStatus run={r} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="history" title="Sem execuções" text="Inicie uma exploração para o agente mapear a aplicação." />
          )}
        </section>

        <section className="card" aria-label="Bugs em destaque">
          <div className="card-head">
            <h2>Bugs em aberto</h2>
            <button type="button" className="link-btn" onClick={() => ws.go("bugs")}>
              Ver todos
            </button>
          </div>
          {openBugs.length > 0 ? (
            <ul className="rows-plain">
              {openBugs.slice(0, 5).map((b) => (
                <li key={b.id}>
                  <span className={`pill sev-${b.severity}`}>{severityLabel(b.severity)}</span>
                  <span className="row-main">
                    <strong className="clip">{b.title}</strong>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="check" title="Nenhum bug aberto" text="Quando uma regressão falhar, o bug aparece aqui, já deduplicado." />
          )}
        </section>

        <AttentionCard />
      </div>
    </div>
  );
}

