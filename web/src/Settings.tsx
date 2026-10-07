import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage, type Credential, type Environment, type Project } from "./api";
import { cronLabel, timeAgo } from "./format";
import { Icon, type IconName } from "./icons";
import { useAppTheme, type ThemePref } from "./theme";
import { CopyButton, EmptyState, PageHeader, Segmented, useToast } from "./ui";

// Same list the server accepts (internal/environment SupportedDevices).
export const DEVICES = ["iPhone 13", "iPhone 14", "Pixel 5", "Pixel 7", "iPad Pro 11", "Galaxy S9+"];

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
}

interface ScheduleRow {
  id: string;
  run_type: string;
  cron: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
}

const TABS: { id: string; label: string; icon: IconName; hint: string }[] = [
  { id: "projetos", label: "Projetos", icon: "folder", hint: "Cada projeto é uma aplicação a ser testada." },
  { id: "ambientes", label: "Ambientes", icon: "server", hint: "Onde a aplicação roda: URL, dispositivo e política de segurança." },
  { id: "credenciais", label: "Credenciais", icon: "key", hint: "Os usuários que o agente usa para entrar. Cadastre vários para descobrir fluxos alternativos." },
  { id: "tokens", label: "Tokens de CI", icon: "sparkles", hint: "Para o `qactl` disparar execuções a partir do seu pipeline." },
  { id: "agendamentos", label: "Agendamentos", icon: "calendar", hint: "Execuções automáticas, como uma exploração toda noite." },
  { id: "aparencia", label: "Aparência", icon: "sun", hint: "Tema claro, escuro ou o do seu sistema." },
];

interface Props {
  token: string;
  projectId: string | undefined;
  envId: string | undefined;
  onChanged: () => void;
  tab?: string | undefined;
  onTab?: (tab: string) => void;
  onSelectProject?: (id: string) => void;
  onSelectEnv?: (id: string) => void;
}

/** Runs an async action, keeps its error for the form and tells the parent something changed. */
function useAction(onChanged: () => void) {
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return { error, run };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

function Panel({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <section className="card panel" aria-label={title}>
      <div className="panel-head">
        <h3>{title}</h3>
        {text && <p className="meta">{text}</p>}
      </div>
      {children}
    </section>
  );
}

export function Settings({ token, projectId, envId, onChanged, tab, onTab, onSelectProject, onSelectEnv }: Props) {
  const [localTab, setLocalTab] = useState("projetos");
  const current = TABS.find((t) => t.id === (tab ?? localTab)) ?? (TABS[0] as (typeof TABS)[number]);
  const select = (id: string) => (onTab ? onTab(id) : setLocalTab(id));

  return (
    <div className="page settings-page">
      <PageHeader title="Configurações" subtitle="Projetos, ambientes, credenciais e automações." />
      <div className="settings-layout">
        <div className="settings-nav" role="tablist" aria-label="Seções" aria-orientation="vertical">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={t.id === current.id} aria-controls="settings-panel" className="tab" onClick={() => select(t.id)}>
              <Icon name={t.icon} size={18} />
              {t.label}
            </button>
          ))}
        </div>
        <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${current.id}`} className="settings-panel">
          <p className="meta panel-intro">{current.hint}</p>
          {current.id === "projetos" && <Projects token={token} projectId={projectId} onChanged={onChanged} onSelect={onSelectProject} />}
          {current.id === "ambientes" && <Environments token={token} projectId={projectId} envId={envId} onChanged={onChanged} onSelect={onSelectEnv} />}
          {current.id === "credenciais" && <Credentials token={token} envId={envId} />}
          {current.id === "tokens" && <Tokens token={token} projectId={projectId} />}
          {current.id === "agendamentos" && <Schedules token={token} envId={envId} />}
          {current.id === "aparencia" && <Appearance />}
        </div>
      </div>
    </div>
  );
}

/* ---------- Projects ---------- */

function Projects({ token, projectId, onChanged, onSelect }: { token: string; projectId: string | undefined; onChanged: () => void; onSelect: ((id: string) => void) | undefined }) {
  const toast = useToast();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/api/v1/projects", token) });
  const [name, setName] = useState("");
  const { error, run } = useAction(onChanged);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api("/api/v1/projects", token, { method: "POST", body: JSON.stringify({ name: name.trim() }) }).then(() => undefined));
    if (ok) {
      setName("");
      toast.show({ kind: "success", title: "Projeto criado" });
    }
  }

  return (
    <>
      <Panel title="Seus projetos">
        {projects.data && projects.data.length > 0 ? (
          <ul className="rows" aria-label="Projetos">
            {projects.data.map((p) => (
              <li key={p.id}>
                <span className="row-icon">
                  <Icon name="folder" size={16} />
                </span>
                <strong>{p.name}</strong>
                {p.id === projectId ? (
                  <span className="chip tone-ok">Em uso</span>
                ) : (
                  onSelect && (
                    <button type="button" className="btn sm" onClick={() => onSelect(p.id)}>
                      Usar este
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="folder" title="Nenhum projeto ainda" text="Crie o primeiro abaixo." />
        )}
      </Panel>
      <Panel title="Novo projeto">
        <form onSubmit={submit}>
          <Field label="Nome do projeto">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Portal de Clientes" required />
          </Field>
          <button type="submit" className="btn primary">
            Criar projeto
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ---------- Environments ---------- */

const POLICY: Record<string, string> = { block: "Ações destrutivas bloqueadas", confirm: "Ações destrutivas com confirmação", allow: "Ações destrutivas permitidas" };

function Environments({ token, projectId, envId, onChanged, onSelect }: { token: string; projectId: string | undefined; envId: string | undefined; onChanged: () => void; onSelect: ((id: string) => void) | undefined }) {
  const toast = useToast();
  const envs = useQuery({
    queryKey: ["envs", projectId],
    queryFn: () => api<Environment[]>(`/api/v1/projects/${projectId}/environments`, token),
    enabled: !!projectId,
  });
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [device, setDevice] = useState("");
  const [kind, setKind] = useState<"web" | "terminal">("web");
  const [binary, setBinary] = useState("");
  const [image, setImage] = useState("");
  const [policy, setPolicy] = useState<"block" | "allow">("block");
  const { error, run } = useAction(onChanged);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const policyField = policy === "allow" ? { destructive_policy: policy } : {};
    const body =
      kind === "terminal"
        ? { name: name.trim(), kind, binary: binary.trim(), ...(image.trim() ? { image: image.trim() } : {}), ...policyField }
        : { name: name.trim(), base_url: baseUrl.trim(), ...(device ? { device } : {}), ...policyField };
    const ok = await run(() => api(`/api/v1/projects/${projectId}/environments`, token, { method: "POST", body: JSON.stringify(body) }).then(() => undefined));
    if (ok) {
      setName("");
      setBaseUrl("");
      setDevice("");
      setBinary("");
      setImage("");
      setPolicy("block");
      toast.show({ kind: "success", title: "Ambiente criado" });
    }
  }

  return (
    <>
      <Panel title="Ambientes do projeto">
        {!projectId ? (
          <EmptyState icon="folder" title="Escolha um projeto" text="Os ambientes pertencem a um projeto." />
        ) : envs.data && envs.data.length > 0 ? (
          <ul className="rows" aria-label="Ambientes">
            {envs.data.map((e) => (
              <li key={e.id} className="tall">
                <span className="row-icon">
                  <Icon name="server" size={16} />
                </span>
                <span className="row-main">
                  <strong>{e.name}</strong>
                  <span className="meta clip">{e.kind === "terminal" ? `CLI · ${e.binary ?? ""}` : e.base_url}</span>
                  <span className="tags">
                    <span className="pill">{e.kind === "terminal" ? "Terminal" : e.device ? e.device : "Desktop"}</span>
                    {e.destructive_policy && <span className="pill">{POLICY[e.destructive_policy] ?? e.destructive_policy}</span>}
                    {e.is_production && <span className="pill sev-high">Produção (não executa)</span>}
                  </span>
                </span>
                {e.id === envId ? (
                  <span className="chip tone-ok">Em uso</span>
                ) : (
                  onSelect && (
                    <button type="button" className="btn sm" onClick={() => onSelect(e.id)}>
                      Usar este
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="server" title="Nenhum ambiente ainda" text="Cadastre abaixo a aplicação que será testada." />
        )}
      </Panel>

      <Panel title="Novo ambiente" text="Ambientes novos bloqueiam ações destrutivas e só permitem o host da URL base.">
        <form onSubmit={submit}>
          <Field label="Nome do ambiente">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: homologação" required />
          </Field>
          <div className="field">
            <span className="label">Tipo do ambiente</span>
            <Segmented
              label="Tipo do ambiente"
              value={kind}
              onChange={setKind}
              options={[
                { value: "web", label: "Web", icon: "monitor" },
                { value: "terminal", label: "Terminal (CLI)", icon: "server" },
              ]}
            />
          </div>
          {kind === "web" ? (
            <>
              <Field label="URL base" hint="De dentro do Docker, o seu Mac é host.docker.internal.">
                <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://hml.exemplo.com" required />
              </Field>
              <Field label="Dispositivo">
                <select value={device} onChange={(e) => setDevice(e.target.value)}>
                  <option value="">Desktop</option>
                  {DEVICES.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Binário do CLI">
                <input value={binary} onChange={(e) => setBinary(e.target.value)} placeholder="Ex.: samplecli" required />
              </Field>
              <Field label="Imagem do runner (opcional)" hint="O CLI roda sem rede, dentro de um runner efêmero com os labels `terminal` e `image:<imagem>`.">
                <input value={image} onChange={(e) => setImage(e.target.value)} />
              </Field>
            </>
          )}
          <Field
            label="Ações que alteram dados"
            hint={
              policy === "allow"
                ? "O agente cria, edita e apaga dados e pode disparar envios (e-mail, WhatsApp). Use só em ambiente de testes, com dados fictícios. Sair da conta e apagá-la nunca são tocados."
                : "O agente preenche e experimenta formulários, mas toda requisição que altera dados é barrada antes de sair da máquina. Ele aprende o endereço e o verbo, sem mudar nada."
            }
          >
            <select value={policy} onChange={(e) => setPolicy(e.target.value as "block" | "allow")}>
              <option value="block">Bloquear (recomendado)</option>
              <option value="allow">Permitir (explora de verdade)</option>
            </select>
          </Field>
          <button type="submit" className="btn primary" disabled={!projectId}>
            Criar ambiente
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ---------- Credentials ---------- */

function Credentials({ token, envId }: { token: string; envId: string | undefined }) {
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["credentials", envId],
    queryFn: () => api<Credential[]>(`/api/v1/environments/${envId}/credentials`, token),
    enabled: !!envId,
  });
  const [role, setRole] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState(false);
  const { error, run } = useAction(() => void qc.invalidateQueries({ queryKey: ["credentials"] }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const ok = await run(() =>
      api(`/api/v1/environments/${envId}/credentials`, token, {
        method: "PUT",
        body: JSON.stringify({ app_role: role.trim(), kind: "login", payload: { username: user, password } }),
      }).then(() => undefined),
    );
    if (ok) {
      setPassword(""); // the secret never stays in the page
      setSaved(true);
    }
  }

  return (
    <>
      <Panel title="Credenciais salvas" text="As senhas são cifradas e nunca voltam para a tela.">
        {!envId ? (
          <EmptyState icon="server" title="Escolha um ambiente" text="As credenciais pertencem a um ambiente." />
        ) : creds.data && creds.data.length > 0 ? (
          <ul className="rows" aria-label="Credenciais">
            {creds.data.map((c) => (
              <li key={c.id}>
                <span className="row-icon">
                  <Icon name="key" size={16} />
                </span>
                <strong>{c.app_role}</strong>
                <span className="pill">{c.kind === "login" ? "usuário e senha" : c.kind}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="key" title="Nenhuma credencial" text="Sem credencial o agente só enxerga as telas públicas." />
        )}
      </Panel>
      <Panel title="Adicionar ou atualizar" text="Cada usuário é explorado e testado separadamente, e a execução diz qual deles foi testado. Se o nome já existir, a credencial é substituída.">
        <form onSubmit={submit}>
          <Field label="Nome do usuário (perfil)" hint="Um nome para este usuário: admin, operador, advogada com clientes, advogada sem clientes…">
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Ex.: operador" required />
          </Field>
          <Field label="Login (usuário ou e-mail)">
            <input value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="off" />
          </Field>
          <Field label="Senha">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
          </Field>
          <button type="submit" className="btn primary" disabled={!envId}>
            Salvar credencial
          </button>
          {saved && <p role="status">Credencial salva (cifrada; não é exibida novamente).</p>}
          {error && <p role="alert">{error}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ---------- CI tokens ---------- */

function Tokens({ token, projectId }: { token: string; projectId: string | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const tokens = useQuery({
    queryKey: ["tokens", projectId],
    queryFn: () => api<TokenRow[]>(`/api/v1/projects/${projectId}/tokens`, token),
    enabled: !!projectId,
  });
  const { error, run } = useAction(() => void qc.invalidateQueries({ queryKey: ["tokens"] }));

  async function create(e: FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      const r = await api<{ token: string }>(`/api/v1/projects/${projectId}/tokens`, token, { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setSecret(r.token);
    });
    if (ok) setName("");
  }

  return (
    <>
      {secret && (
        <section className="card secret" role="status">
          <h3>
            <Icon name="alert" size={18} /> Copie agora, não será mostrado novamente
          </h3>
          <div className="secret-row">
            <code>{secret}</code>
            <CopyButton text={secret} />
          </div>
          <p className="meta">
            Use no pipeline: <code>QACTL_TOKEN</code>.
          </p>
        </section>
      )}
      <Panel title="Tokens do projeto">
        {tokens.data && tokens.data.length > 0 ? (
          <ul className="rows" aria-label="Tokens">
            {tokens.data.map((t) => (
              <li key={t.id}>
                <span className="row-icon">
                  <Icon name="key" size={16} />
                </span>
                <span className="row-main">
                  <strong>{t.name}</strong>
                  <span className="meta">
                    {t.scopes.join(", ")} · {t.last_used_at ? `usado ${timeAgo(t.last_used_at)}` : "nunca usado"}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn sm danger"
                  aria-label={`Revogar ${t.name}`}
                  onClick={() => void run(() => api(`/api/v1/tokens/${t.id}`, token, { method: "DELETE" }).then(() => toast.show({ kind: "info", title: "Token revogado" })))}
                >
                  Revogar
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="key" title="Nenhum token" text="Crie um para disparar execuções pelo `qactl`." />
        )}
      </Panel>
      <Panel title="Novo token">
        <form onSubmit={create}>
          <Field label="Nome do token" hint="Ex.: github-actions, jenkins-hml.">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <button type="submit" className="btn primary" disabled={!projectId}>
            Criar token
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ---------- Schedules ---------- */

const PRESETS: { label: string; cron: string }[] = [
  { label: "Todo dia às 02:00", cron: "0 2 * * *" },
  { label: "Dias úteis às 08:00", cron: "0 8 * * 1-5" },
  { label: "A cada 6 horas", cron: "0 */6 * * *" },
];

function Schedules({ token, envId }: { token: string; envId: string | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState("exploration");
  const [cron, setCron] = useState(PRESETS[0]?.cron ?? "");
  const list = useQuery({
    queryKey: ["schedules", envId],
    queryFn: () => api<ScheduleRow[]>(`/api/v1/environments/${envId}/schedules`, token),
    enabled: !!envId,
  });
  const { error, run } = useAction(() => void qc.invalidateQueries({ queryKey: ["schedules"] }));
  const preset = PRESETS.find((p) => p.cron === cron.trim())?.cron ?? "custom";

  async function create(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api(`/api/v1/environments/${envId}/schedules`, token, { method: "POST", body: JSON.stringify({ run_type: type, cron: cron.trim() }) }).then(() => undefined));
    if (ok) toast.show({ kind: "success", title: "Agendamento criado" });
  }

  return (
    <>
      <Panel title="Agendamentos do ambiente">
        {!envId ? (
          <EmptyState icon="server" title="Escolha um ambiente" text="Os agendamentos pertencem a um ambiente." />
        ) : list.data && list.data.length > 0 ? (
          <ul className="rows" aria-label="Agendamentos">
            {list.data.map((s) => (
              <li key={s.id} className="tall">
                <span className="row-icon">
                  <Icon name="calendar" size={16} />
                </span>
                <span className="row-main">
                  <strong>{cronLabel(s.cron)}</strong>
                  <span className="meta">
                    <code>{s.cron}</code> · {s.run_type === "exploration" ? "exploração" : "regressão"} · {s.enabled ? "ativo" : "pausado"}
                  </span>
                </span>
                <button type="button" className="btn sm" onClick={() => void run(() => api(`/api/v1/schedules/${s.id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) }).then(() => undefined))}>
                  {s.enabled ? "Pausar" : "Ativar"}
                </button>
                <button type="button" className="btn sm danger" onClick={() => void run(() => api(`/api/v1/schedules/${s.id}`, token, { method: "DELETE" }).then(() => undefined))}>
                  Remover agendamento
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="calendar" title="Nenhum agendamento" text="Uma exploração toda noite mantém o mapa e os bugs sempre atualizados." />
        )}
      </Panel>
      <Panel title="Novo agendamento" text="Intervalo mínimo de 5 minutos.">
        <form onSubmit={create}>
          <Field label="Tipo do agendamento">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="exploration">Exploração</option>
              <option value="regression">Regressão</option>
            </select>
          </Field>
          <Field label="Frequência">
            <select value={preset} onChange={(e) => e.target.value !== "custom" && setCron(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Personalizada</option>
            </select>
          </Field>
          <Field label="Cron" hint="Minuto, hora, dia do mês, mês, dia da semana.">
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 2 * * *" required />
          </Field>
          <button type="submit" className="btn primary" disabled={!envId}>
            Criar agendamento
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Panel>
    </>
  );
}

/* ---------- Appearance ---------- */

function Appearance() {
  const { pref, setPref } = useAppTheme();
  return (
    <Panel title="Tema" text="Automático segue a configuração do seu sistema.">
      <Segmented<ThemePref>
        label="Tema"
        value={pref}
        onChange={setPref}
        options={[
          { value: "system", label: "Automático", icon: "monitor" },
          { value: "light", label: "Claro", icon: "sun" },
          { value: "dark", label: "Escuro", icon: "moon" },
        ]}
      />
    </Panel>
  );
}
