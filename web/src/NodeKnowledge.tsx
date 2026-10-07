import type { GraphNode } from "./api";

const INTENT: Record<string, string> = {
  create: "criar",
  save: "salvar",
  search: "buscar",
  filter: "filtrar",
  edit: "editar",
  open: "abrir",
  navigate: "navegar",
  delete: "apagar",
  external: "dispara algo fora do app",
  toggle: "mostrar/ocultar",
  never: "não é tocado",
  other: "outro",
};
const RISKY = new Set(["delete", "external", "never"]);

interface Form {
  label: string;
  method: string;
  action: string;
  purpose?: string;
  fields?: { name: string; label: string; type: string; required: boolean }[];
}
interface Control {
  label: string;
  intent: string;
  what?: string;
}
interface Action {
  kind: string;
  label: string;
  intent: string;
  requests: string[];
  went_to?: string;
  messages?: string[];
  dialog?: string;
}
interface Observed {
  statuses?: number[];
  blocked?: boolean;
  fields?: string[];
  triggers?: { label: string; intent: string }[];
  seen_on?: string;
}

const KIND: Record<string, string> = { "submit-empty": "enviou vazio", "submit-valid": "enviou com dados", click: "clicou", search: "buscou" };

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function Intent({ intent }: { intent: string }) {
  return <span className={`pill${RISKY.has(intent) ? " sev-high" : ""}`}>{INTENT[intent] ?? intent}</span>;
}

/** What the exploration learned about a node: the reading of the screen, its forms, and what happened when they were used. */
export function NodeKnowledge({ node }: { node: GraphNode }) {
  const m = node.metadata;
  const summary = str(m["summary"]);
  const forms = arr<Form>(m["forms"]);
  const controls = arr<Control>(m["controls"]);
  const actions = arr<Action>(m["actions"]);
  const observed = (m["observed"] ?? null) as Observed | null;
  const openedBy = str(m["opened_by"]);
  if (!summary && forms.length === 0 && controls.length === 0 && actions.length === 0 && !observed && !openedBy) return null;

  return (
    <section aria-label="O que o agente entendeu" className="knowledge">
      <h3>O que o agente entendeu</h3>
      {openedBy && (
        <p className="meta">
          Abre ao clicar em <strong>{openedBy}</strong>.
        </p>
      )}
      {summary && <p>{summary}</p>}

      {observed && (
        <div className="kn-block">
          {observed.seen_on && <p className="meta">Visto em {observed.seen_on}</p>}
          {observed.triggers && observed.triggers.length > 0 && (
            <p className="meta">Disparado por: {observed.triggers.map((t) => t.label).join(", ")}</p>
          )}
          {observed.blocked ? (
            <p className="meta">A chamada não foi enviada: o ambiente não permite alterar dados. O endereço e o verbo foram aprendidos mesmo assim.</p>
          ) : (
            observed.statuses && observed.statuses.length > 0 && (
              <p className="meta">
                Respostas: {observed.statuses.map((s) => (
                  <code key={s}>{s}</code>
                ))}
              </p>
            )
          )}
          {observed.fields && observed.fields.length > 0 && (
            <p className="tags">
              {observed.fields.map((f) => (
                <code key={f}>{f}</code>
              ))}
            </p>
          )}
        </div>
      )}

      {forms.length > 0 && (
        <div className="kn-block">
          <h4>Formulários</h4>
          <ul className="kn-list">
            {forms.map((f, i) => (
              <li key={i}>
                <strong>{f.label || "Formulário"}</strong> <code>{`${f.method} ${f.action}`}</code>
                {f.purpose && <span className="meta">{f.purpose}</span>}
                {f.fields && f.fields.length > 0 && (
                  <span className="tags">
                    {f.fields.map((x) => (
                      <span className="pill" key={x.name}>
                        {(x.label || x.name) + (x.required ? "*" : "")}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {controls.length > 0 && (
        <div className="kn-block">
          <h4>Botões</h4>
          <ul className="kn-list">
            {controls.map((c, i) => (
              <li key={i}>
                <strong>{c.label}</strong> <Intent intent={c.intent} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {actions.length > 0 && (
        <div className="kn-block">
          <h4>O que foi tentado</h4>
          <ul className="kn-list">
            {actions.map((a, i) => (
              <li key={i}>
                <span>
                  {KIND[a.kind] ?? a.kind} <strong>{a.label}</strong> <Intent intent={a.intent} />
                </span>
                {a.requests.map((r) => (
                  <code key={r}>{r}</code>
                ))}
                {a.went_to && (
                  <span className="meta">
                    levou a <code>{a.went_to}</code>
                  </span>
                )}
                {a.dialog && <span className="meta">pediu confirmação: “{a.dialog}”</span>}
                {a.messages?.map((msg) => (
                  <span className="meta" key={msg}>
                    {msg}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
