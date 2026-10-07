import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type DragEvent } from "react";
import { api, errorMessage, type SpecResult } from "./api";
import { formatClock, useTicker } from "./progress";
import { plural } from "./format";
import { Icon } from "./icons";
import { Modal, Segmented, useToast } from "./ui";

type SourceType = "text" | "openapi";
type Phase = { name: "form" } | { name: "working"; since: number } | { name: "done"; result: SpecResult } | { name: "error"; message: string };

const MAX_FILE = 2 * 1024 * 1024; // the server refuses OpenAPI documents above this
const ACCEPT = ".md,.txt,.json,.yaml,.yml,text/plain,text/markdown,application/json";

const CRITICALITY: Record<string, string> = { critical: "crítico", high: "alto", normal: "normal" };
const CHANGE: Record<string, string> = { new: "novo", changed: "alterado" };

function Steps({ kind, since }: { kind: SourceType; since: number }) {
  useTicker();
  return (
    <div className="working" aria-live="polite">
      <ol className="stepper">
        <li className="done">
          <span className="step-mark">
            <Icon name="check" size={14} />
          </span>
          Especificação enviada
        </li>
        <li className="active">
          <span className="step-mark">
            <span className="spinner sm" aria-hidden="true" />
          </span>
          <span>
            {kind === "text" ? "Extraindo os requisitos com IA" : "Lendo o contrato OpenAPI"}
            <small>{formatClock((Date.now() - since) / 1000)}</small>
          </span>
        </li>
        <li>
          <span className="step-mark">3</span>
          Comparando com a versão anterior e salvando
        </li>
      </ol>
      <div className="bar indeterminate" role="progressbar" aria-label="Processando a especificação">
        <span />
      </div>
      <p className="meta">
        {kind === "text" ? "Modelos locais podem levar mais de um minuto. Não feche esta janela." : "Costuma levar poucos segundos."}
      </p>
    </div>
  );
}

export function SpecDialog({
  token,
  projectId,
  canCrossref,
  onCrossref,
  onClose,
}: {
  token: string;
  projectId: string;
  canCrossref: boolean;
  onCrossref: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<SourceType>("text");
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const picker = useRef<HTMLInputElement>(null);

  async function load(file: File) {
    if (file.size > MAX_FILE) {
      setFileNote(`O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB; o limite é 2 MB.`);
      return;
    }
    const content = await file.text();
    setText(content);
    setFileNote(`${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`);
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
    if (/\.(json|ya?ml)$/i.test(file.name) && /["']?openapi["']?\s*:/i.test(content.slice(0, 2000))) setType("openapi");
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void load(file);
  }

  async function submit() {
    setPhase({ name: "working", since: Date.now() });
    try {
      const result = await api<SpecResult>(`/api/v1/projects/${projectId}/specs`, token, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), source_type: type, text }),
      });
      await qc.invalidateQueries({ queryKey: ["specs"] });
      await qc.invalidateQueries({ queryKey: ["coverage"] });
      toast.show({ kind: "success", title: "Especificação salva", text: `Versão ${result.spec.version} com ${plural(result.requirements.length, "requisito", "requisitos")}.` });
      setPhase({ name: "done", result });
    } catch (e) {
      setPhase({ name: "error", message: errorMessage(e) });
    }
  }

  const working = phase.name === "working";
  const ready = title.trim() !== "" && text.trim() !== "";

  return (
    <Modal
      title="Nova especificação"
      subtitle="O agente transforma a spec em requisitos testáveis, com ID estável entre as versões."
      onClose={onClose}
      busy={working}
      wide
    >
      {phase.name === "form" && (
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void submit();
          }}
        >
          <div className="grid-2">
            <label>
              Título da spec
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Regras de cobrança v2" required />
            </label>
            <div className="field">
              <span className="label">Tipo da spec</span>
              <Segmented
                label="Tipo da spec"
                value={type}
                onChange={setType}
                options={[
                  { value: "text", label: "Texto (IA)", icon: "sparkles" },
                  { value: "openapi", label: "OpenAPI", icon: "server" },
                ]}
              />
            </div>
          </div>

          <div
            className={`dropzone${dragging ? " over" : ""}`}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Icon name="upload" size={22} />
            <span>
              Arraste um arquivo <code>.md</code>, <code>.txt</code>, <code>.json</code> ou <code>.yaml</code> aqui, ou
            </span>
            <button type="button" className="btn sm" onClick={() => picker.current?.click()}>
              Escolher arquivo
            </button>
            <input ref={picker} type="file" accept={ACCEPT} hidden aria-label="Arquivo da spec" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
            {fileNote && <span className="meta">{fileNote}</span>}
          </div>

          <label>
            Conteúdo da spec
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} required placeholder={type === "text" ? "Cole aqui os requisitos, regras de negócio, fluxos…" : "Cole aqui o OpenAPI 3.x em JSON ou YAML"} />
          </label>
          <p className="meta">
            {type === "text"
              ? "O texto vai para o modelo de IA configurado. Não inclua dados pessoais reais."
              : "O contrato é lido de forma determinística, sem IA: cada operação com resposta 2xx vira um requisito de contrato."}
          </p>

          <footer className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" disabled={!ready}>
              Enviar spec
            </button>
          </footer>
        </form>
      )}

      {phase.name === "working" && (
        <div className="modal-body">
          <Steps kind={type} since={phase.since} />
        </div>
      )}

      {phase.name === "done" && (
        <div className="modal-body">
          <div className="result-head">
            <span className="result-icon ok">
              <Icon name="check" size={22} />
            </span>
            <div>
              <h3>Versão {phase.result.spec.version} salva</h3>
              <p className="meta">
                {plural(phase.result.requirements.length, "requisito", "requisitos")}
                {phase.result.requirements.some((r) => r.status === "new") && ` · ${plural(phase.result.requirements.filter((r) => r.status === "new").length, "novo", "novos")}`}
                {phase.result.requirements.some((r) => r.status === "changed") && ` · ${plural(phase.result.requirements.filter((r) => r.status === "changed").length, "alterado", "alterados")}`}
                {phase.result.removed.length > 0 && ` · ${plural(phase.result.removed.length, "removido", "removidos")}`}
              </p>
            </div>
          </div>
          {phase.result.skipped && phase.result.skipped.length > 0 && (
            <p className="meta">
              {plural(phase.result.skipped.length, "operação", "operações")} sem resposta 2xx {phase.result.skipped.length === 1 ? "foi ignorada" : "foram ignoradas"}.
            </p>
          )}
          <ul className="req-list" aria-label="Requisitos extraídos">
            {phase.result.requirements.map((r) => (
              <li key={r.key}>
                <code>{r.key}</code>
                <span className={`pill sev-${r.criticality}`}>{CRITICALITY[r.criticality] ?? r.criticality}</span>
                <span className="req-text">{r.text}</span>
                {r.status && CHANGE[r.status] && <span className={`pill status-${r.status === "new" ? "new" : "reopened"}`}>{CHANGE[r.status]}</span>}
              </li>
            ))}
          </ul>
          <footer className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              Fechar
            </button>
            {canCrossref && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  onClose();
                  onCrossref();
                }}
              >
                <Icon name="link" size={16} /> Cruzar com o mapa
              </button>
            )}
          </footer>
        </div>
      )}

      {phase.name === "error" && (
        <div className="modal-body">
          <div className="result-head">
            <span className="result-icon bad">
              <Icon name="alert" size={22} />
            </span>
            <div>
              <h3>Não foi possível processar a spec</h3>
              <p role="alert">{phase.message}</p>
            </div>
          </div>
          <footer className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              Fechar
            </button>
            <button type="button" className="btn primary" onClick={() => setPhase({ name: "form" })}>
              Voltar e editar
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
