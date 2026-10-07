import { useState } from "react";
import type { RunBudgetInput } from "./api";
import { Icon } from "./icons";
import { resumableExploration, stoppedBecause } from "./resume";
import { Modal, Segmented } from "./ui";
import { useWorkspace, type Workspace } from "./workspace";

type Preset = "quick" | "standard" | "deep" | "large" | "custom";

/** How far an exploration goes. "standard" sends nothing, so the server's defaults apply. */
export const PRESETS: Record<Exclude<Preset, "custom">, { label: string; hint: string; budget: RunBudgetInput }> = {
  quick: { label: "Rápida", hint: "Até 20 telas, 5 min. Bom para conferir se o login e o básico funcionam.", budget: { max_pages: 20, max_depth: 3, max_actions: 20, max_seconds: 300, max_llm_calls: 10 } },
  standard: { label: "Padrão", hint: "Até 50 telas, 15 min.", budget: {} },
  deep: { label: "Profunda", hint: "Até 200 telas e 300 ações, 30 min.", budget: { max_pages: 200, max_depth: 6, max_actions: 300, max_seconds: 1800, max_llm_calls: 60 } },
  large: { label: "App grande", hint: "Até 1.000 telas e 1.200 ações, 2 h. Deixe rodando.", budget: { max_pages: 1000, max_depth: 8, max_actions: 1200, max_seconds: 7200, max_llm_calls: 150 } },
};

const FIELDS: { key: keyof typeof DEFAULTS; label: string; max: number; unit?: string }[] = [
  { key: "max_pages", label: "Telas", max: 2000 },
  { key: "max_depth", label: "Profundidade", max: 15 },
  { key: "max_actions", label: "Ações no navegador", max: 2000 },
  { key: "max_seconds", label: "Tempo", max: 14400, unit: "min" },
  { key: "max_llm_calls", label: "Chamadas de IA", max: 200 },
];

const DEFAULTS: Required<Omit<RunBudgetInput, "concurrency" | "resume" | "no_security">> = { max_pages: 50, max_depth: 4, max_actions: 60, max_seconds: 900, max_llm_calls: 30 };

/** Asks which users to test as (regression) or how far to go (exploration), then starts the run. */
export function RunDialog() {
  const ws = useWorkspace();
  // mounted only while open, so every opening starts from the defaults and the users are already loaded
  return ws.runDialog ? <RunDialogBody dialog={ws.runDialog} /> : null;
}

function RunDialogBody({ dialog }: { dialog: NonNullable<Workspace["runDialog"]> }) {
  const ws = useWorkspace();
  const users = [...new Set((ws.credentials ?? []).filter((c) => c.kind === "login").map((c) => c.app_role))];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(users));
  const [preset, setPreset] = useState<Preset>("standard");
  const [custom, setCustom] = useState<Required<Omit<RunBudgetInput, "concurrency" | "resume" | "no_security">>>(DEFAULTS);
  const [parallel, setParallel] = useState(1);
  const [security, setSecurity] = useState(true);
  const [busy, setBusy] = useState(false);
  const interrupted = dialog.type === "exploration" ? resumableExploration(ws.runs.data) : undefined;
  const [resume, setResume] = useState(Boolean(dialog.resume && interrupted));
  const isRegression = dialog.type === "regression";
  const spec = dialog.specId ? ws.specs?.find((s) => s.id === dialog.specId) : undefined;
  const allPicked = picked.size === users.length;
  const budget: RunBudgetInput = preset === "custom" ? custom : PRESETS[preset].budget;

  function toggle(user: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(user)) next.delete(user);
      else next.add(user);
      return next;
    });
  }

  function edit(key: keyof typeof DEFAULTS, raw: string, unit?: string) {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    setPreset("custom");
    setCustom((c) => ({ ...(preset === "custom" ? c : { ...DEFAULTS, ...PRESETS[preset].budget }), [key]: unit === "min" ? n * 60 : n }));
  }

  async function submit() {
    setBusy(true);
    try {
      await ws.startRun(dialog.type, {
        ...(dialog.specId ? { specId: dialog.specId } : {}),
        roles: allPicked ? [] : [...picked],
        ...(isRegression
          ? { budget: { ...(parallel > 1 ? { concurrency: parallel } : {}), ...(security ? {} : { no_security: true }) } }
          : { budget: { ...budget, ...(resume ? { resume: true } : {}), ...(security ? {} : { no_security: true }) } }),
      });
    } finally {
      setBusy(false);
      ws.closeRunDialog();
    }
  }

  const shown = preset === "custom" ? custom : { ...DEFAULTS, ...PRESETS[preset].budget };

  return (
    <Modal
      title={isRegression ? "Nova regressão" : "Nova exploração"}
      subtitle={isRegression ? (spec ? `Só a especificação “${spec.title}”.` : "Testa o que o mapa já tem, com os requisitos ligados.") : "O agente entra com cada usuário cadastrado e mapeia o que cada um enxerga."}
      onClose={ws.closeRunDialog}
      busy={busy}
    >
      <div className="modal-body">
        {isRegression && (
          <label className="field">
            <span className="label">Navegadores em paralelo por usuário</span>
            <select value={parallel} onChange={(e) => setParallel(Number(e.target.value))} aria-label="Navegadores em paralelo">
              <option value={1}>1 (padrão, o mais seguro)</option>
              <option value={2}>2</option>
              <option value={4}>4 (apps grandes)</option>
            </select>
            <span className="meta">Mais navegadores terminam antes, mas alguns sistemas encerram a primeira sessão quando o mesmo usuário entra de novo.</span>
          </label>
        )}
        {isRegression ? (
          users.length === 0 ? (
            <p className="meta">Este ambiente não tem usuários cadastrados: o agente testa sem login.</p>
          ) : (
            <fieldset className="user-picker">
              <legend>Testar como</legend>
              {users.map((u) => (
                <label key={u} className="check">
                  <input type="checkbox" checked={picked.has(u)} onChange={() => toggle(u)} />
                  <span>{u}</span>
                </label>
              ))}
              <p className="meta">
                Cada usuário é testado nas telas que ele alcançou na exploração. Escolher só um serve para conferir um fluxo alternativo, como o do operador.
              </p>
            </fieldset>
          )
        ) : (
          <>
            {interrupted && (
              <label className="check resume-choice">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                <span>
                  <strong>Continuar de onde parou</strong>
                  <span className="meta">
                    {" "}
                    A última exploração {stoppedBecause(interrupted)}. Continua no mesmo mapa: o que já foi examinado não é refeito e os limites abaixo valem só para as telas novas.
                  </span>
                </span>
              </label>
            )}
            {users.length > 0 && (
              <fieldset className="user-picker">
                <legend>Explorar como</legend>
                {users.map((u) => (
                  <label key={u} className="check">
                    <input type="checkbox" checked={picked.has(u)} onChange={() => toggle(u)} />
                    <span>{u}</span>
                  </label>
                ))}
                {!allPicked && <p className="meta">As telas dos outros usuários continuam como estão no mapa; só as dos marcados são mapeadas de novo.</p>}
              </fieldset>
            )}
            <Segmented<Preset>
              label="Profundidade"
              value={preset}
              onChange={setPreset}
              options={[
                ...(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => ({ value: k, label: PRESETS[k].label })),
                { value: "custom", label: "Personalizar" },
              ]}
            />
            <p className="meta">{preset === "custom" ? "Ajuste cada limite. A exploração para no primeiro que for atingido." : PRESETS[preset].hint}</p>
            <div className="grid-2">
              {FIELDS.map((f) => (
                <label key={f.key} className="field">
                  <span className="label">
                    {f.label}
                    {f.unit ? ` (${f.unit})` : ""}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={f.unit === "min" ? f.max / 60 : f.max}
                    value={f.unit === "min" ? Math.round(shown[f.key] / 60) : shown[f.key]}
                    onChange={(e) => edit(f.key, e.target.value, f.unit)}
                  />
                </label>
              ))}
            </div>
          </>
        )}
        <label className="check security-choice">
          <input type="checkbox" checked={security} onChange={(e) => setSecurity(e.target.checked)} />
          <span>
            <strong>Verificar segurança</strong>
            <span className="meta">
              {" "}
              Cabeçalhos, cookies, token anti-CSRF, XSS, SQL injection, redirecionamento aberto e arquivos expostos, junto com o resto. Só leituras: nada é alterado, mesmo
              com a política Permitir. Não substitui um pentest.
            </span>
          </span>
        </label>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={ws.closeRunDialog} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || (users.length > 0 && picked.size === 0)} autoFocus>
            <Icon name={isRegression ? "repeat" : "explore"} size={16} /> {isRegression ? "Iniciar regressão" : "Iniciar exploração"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
