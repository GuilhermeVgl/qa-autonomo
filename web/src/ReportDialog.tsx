import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "./api";
import { fileName, render, renderHtml, type BriefFormat, type BriefNarrative, type BriefResponse } from "./briefReport";
import { Icon } from "./icons";
import { Modal, useToast } from "./ui";
import { useWorkspace } from "./workspace";

/** Saves a text as a file, from the browser, with no server round trip. */
export function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens the report in its own window, ready to print or save as PDF. */
export function printReport(r: BriefResponse): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(renderHtml(r));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
  return true;
}

const SEVERITY_TONE: Record<string, string> = { alta: "bad", média: "warn", baixa: "info" };

/**
 * The general report of the environment, from any page: what the platform knows, what does not add up between flows and
 * specifications, and the same text written by the model when asked. It exports as HTML (print or PDF), Markdown or JSON.
 */
export function ReportDialog() {
  const ws = useWorkspace();
  return ws.reportOpen && ws.env ? <ReportDialogBody envId={ws.env.id} onClose={() => ws.setReportOpen(false)} /> : null;
}

function ReportDialogBody({ envId, onClose }: { envId: string; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [ai, setAi] = useState<BriefNarrative>();
  const brief = useQuery({
    queryKey: ["brief", envId],
    queryFn: () => api<BriefResponse>(`/api/v1/environments/${envId}/brief`, ws.token),
    staleTime: 0,
    gcTime: 0,
  });
  const write = useMutation({
    mutationFn: () => api<BriefResponse>(`/api/v1/environments/${envId}/brief/narrative`, ws.token, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r) => {
      setAi(r.narrative);
      toast.show({ kind: "success", title: "Resumo escrito pela IA", text: "O texto segue o mesmo formato e usa só os números do relatório." });
    },
    onError: (e) => toast.show({ kind: "error", title: "Não foi possível gerar com IA", text: `${errorMessage(e)} O relatório continua com o texto padrão.` }),
  });

  const data = brief.data;
  const current: BriefResponse | undefined = data && { facts: data.facts, narrative: ai ?? data.narrative };
  const llm = data?.facts.readiness.find((c) => c.id === "llm");

  function save(format: BriefFormat) {
    if (!current) return;
    const { body, type } = render(current, format);
    download(fileName(current, format), body, type);
  }

  return (
    <Modal title="Relatório geral" subtitle="Tudo o que a plataforma sabe deste ambiente, num formato fixo. Os números vêm da aplicação; a IA só reescreve o texto." onClose={onClose} wide>
      <div className="modal-body report-body">
        {brief.isPending && <p className="meta">Reunindo os dados…</p>}
        {brief.isError && <p role="alert">Não foi possível montar o relatório. {errorMessage(brief.error)}</p>}
        {current && (
          <>
            <section aria-label="Resumo executivo" className="report-summary">
              <div className="report-source">
                <span className={`pill ${current.narrative.source === "ai" ? "status-new" : ""}`}>{current.narrative.source === "ai" ? "escrito por IA" : "texto padrão"}</span>
              </div>
              <p>{current.narrative.executive_summary}</p>
            </section>

            <section aria-label="Pontos de atenção">
              <h3>Pontos de atenção</h3>
              {current.facts.issues.length === 0 ? (
                <p className="meta">Nenhum ponto de atenção.</p>
              ) : (
                <ul className="report-issues">
                  {current.facts.issues.map((i) => (
                    <li key={i.code}>
                      <span className={`chip tone-${SEVERITY_TONE[i.severity] ?? "info"}`}>{i.severity}</span>
                      <span>
                        {i.message}
                        {i.items && i.items.length > 0 && (
                          <details>
                            <summary>{i.items.length} {i.items.length === 1 ? "item" : "itens"}</summary>
                            <ul>
                              {i.items.map((it) => (
                                <li key={it}>{it}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Prontidão">
              <h3>Prontidão da ferramenta</h3>
              <ul className="report-checks">
                {current.facts.readiness.map((c) => (
                  <li key={c.id} className={c.ok ? "ok" : "no"}>
                    <Icon name={c.ok ? "check" : "alert"} size={14} /> <strong>{c.label}</strong> <span className="meta">{c.detail}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Texto do relatório">
              {current.narrative.sections.map((s) => (
                <details key={s.id} className="report-section">
                  <summary>{s.title}</summary>
                  <pre className="report-text">{s.body}</pre>
                </details>
              ))}
            </section>
          </>
        )}
        <footer className="modal-foot report-foot">
          <button type="button" className="btn" onClick={() => write.mutate()} disabled={!current || write.isPending || llm?.ok === false} title={llm?.ok === false ? "Nenhum modelo de IA configurado neste servidor" : "Reescreve o texto com IA, no mesmo formato"}>
            {write.isPending ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="sparkles" size={16} />} Resumir com IA
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => save("html")} disabled={!current}>
            <Icon name="file" size={16} /> Baixar HTML
          </button>
          <button type="button" className="btn" onClick={() => save("md")} disabled={!current}>
            Markdown
          </button>
          <button type="button" className="btn" onClick={() => save("json")} disabled={!current}>
            JSON
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => current && !printReport(current) && toast.show({ kind: "error", title: "O navegador bloqueou a janela", text: "Permita pop-ups para imprimir, ou baixe o HTML e abra no navegador." })}
            disabled={!current}
          >
            Imprimir / PDF
          </button>
        </footer>
      </div>
    </Modal>
  );
}
