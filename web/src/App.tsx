import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { browserDeps, completeLogin, startLogin, type OidcConfig } from "./oidc";
import { api, loadAuthConfig, loadToken, saveToken, type AuthConfig, type Me } from "./api";
import { EnvAlert } from "./EnvAlert";
import { Icon, Logo, type IconName } from "./icons";
import { Settings } from "./Settings";
import { ReportDialog } from "./ReportDialog";
import { RunDialog } from "./RunDialog";
import { SpecDialog } from "./SpecDialog";
import { useAppTheme, ThemeProvider, type ThemePref } from "./theme";
import { useRoute, type Page } from "./route";
import { Segmented, ToastProvider } from "./ui";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import { FlowsPage } from "./pages/FlowsPage";
import { MapPage } from "./pages/MapPage";
import { Overview } from "./pages/Overview";
import { ProductPage } from "./pages/ProductPage";
import { SpecsPage } from "./pages/SpecsPage";
import { RunsPage } from "./pages/RunsPage";
import { BugsPage } from "./pages/BugsPage";

export interface AppProps {
  /** Injection points for tests; the defaults use the real browser. */
  startSso?: (config: OidcConfig) => Promise<void>;
  finishSso?: (search: string, config: OidcConfig) => Promise<string | null>;
  search?: string;
}

export function App({
  startSso = (c) => startLogin(c, browserDeps()),
  finishSso = (search, c) => completeLogin(search, c, browserDeps()),
  search = window.location.search,
}: AppProps) {
  const [token, setToken] = useState<string | null>(loadToken);
  const logout = useCallback(() => {
    saveToken(null);
    setToken(null);
  }, []);
  return (
    <ThemeProvider>
      <ToastProvider>
        {token ? (
          <WorkspaceProvider token={token} onLogout={logout}>
            <Shell onLogout={logout} />
          </WorkspaceProvider>
        ) : (
          <Login search={search} startSso={startSso} finishSso={finishSso} onToken={(t) => (saveToken(t), setToken(t))} />
        )}
      </ToastProvider>
    </ThemeProvider>
  );
}

function Login({
  search,
  startSso,
  finishSso,
  onToken,
}: {
  search: string;
  startSso: NonNullable<AppProps["startSso"]>;
  finishSso: NonNullable<AppProps["finishSso"]>;
  onToken: (token: string) => void;
}) {
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadAuthConfig();
        if (cancelled) return;
        setConfig(cfg);
        if (cfg.mode === "oidc" && cfg.issuer && cfg.client_id) {
          // returning from the provider: finish the sign-in and provision the user
          const idToken = await finishSso(search, { issuer: cfg.issuer, clientId: cfg.client_id });
          if (idToken && !cancelled) {
            await api<Me>("/api/v1/auth/login", idToken, { method: "POST" });
            onToken(idToken);
          }
        }
      } catch {
        if (!cancelled) setError(search.includes("code=") ? "Não foi possível concluir o login. Tente entrar novamente." : "Não foi possível carregar a configuração de login.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // run once per page load: the callback code is single-use
  }, []);

  const oidc = config?.mode === "oidc" && config.issuer && config.client_id ? { issuer: config.issuer, clientId: config.client_id } : null;

  return (
    <main className="login">
      <div className="login-theme">
        <ThemeSwitch />
      </div>
      <div className="login-card">
        <Logo size={56} />
        <h1>QA Autônomo</h1>
        <p className="login-sub">Um agente que explora, testa e acompanha a sua aplicação.</p>
        {oidc && (
          <button type="button" className="btn primary lg" onClick={() => startSso(oidc).catch(() => setError("Não foi possível iniciar o login por SSO."))}>
            Entrar com SSO
          </button>
        )}
        {config?.mode === "dev" && <DevLogin onToken={onToken} />}
        {error && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}

// Local users exist only when the server runs with AUTH_MODE=dev.
function DevLogin({ onToken }: { onToken: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = `dev:${email.trim()}`;
    try {
      await api<Me>("/api/v1/auth/login", token, { method: "POST" });
      onToken(token);
    } catch {
      setError("Não foi possível entrar. Verifique o e-mail e se o servidor está em modo de desenvolvimento.");
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        E-mail
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <button type="submit" className="btn primary lg">
        Entrar
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

const THEME_OPTIONS: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "system", label: "Tema automático", icon: "monitor" },
  { value: "light", label: "Tema claro", icon: "sun" },
  { value: "dark", label: "Tema escuro", icon: "moon" },
];

function ThemeSwitch() {
  const { pref, setPref } = useAppTheme();
  return <Segmented<ThemePref> label="Tema" value={pref} onChange={setPref} options={THEME_OPTIONS} iconOnly />;
}

const NAV: { page: Page; label: string; icon: IconName; hash: string }[] = [
  { page: "overview", label: "Visão geral", icon: "home", hash: "#/" },
  { page: "product", label: "Produto", icon: "sparkles", hash: "#/produto" },
  { page: "map", label: "Mapa técnico", icon: "node", hash: "#/mapa" },
  { page: "flows", label: "Fluxos", icon: "flow", hash: "#/fluxos" },
  { page: "specs", label: "Especificações", icon: "file", hash: "#/specs" },
  { page: "bugs", label: "Bugs", icon: "bug", hash: "#/bugs" },
  { page: "runs", label: "Execuções", icon: "history", hash: "#/execucoes" },
  { page: "settings", label: "Configurações", icon: "sliders", hash: "#/config" },
];

const TITLES: Record<Page, string> = { overview: "Visão geral", product: "Produto", map: "Mapa da aplicação", flows: "Fluxos", specs: "Especificações", bugs: "Bugs", runs: "Execuções", settings: "Configurações" };

function Shell({ onLogout }: { onLogout: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { page, sub, go } = useRoute();
  const { me, env, activeRun } = ws;

  useEffect(() => {
    document.title = `${TITLES[page]} · QA Autônomo`;
  }, [page]);

  if (me.isPending)
    return (
      <div className="center-screen">
        <span className="spinner" aria-hidden="true" />
        <p>Carregando…</p>
      </div>
    );
  if (!me.data)
    return (
      <div className="center-screen">
        <p role="alert">Não foi possível carregar a sessão.</p>
      </div>
    );

  const badge = (p: Page): number | undefined => (p === "bugs" && ws.openBugs.length > 0 ? ws.openBugs.length : undefined);

  return (
    <div className="workspace">
      <nav className="sidebar" aria-label="Navegação">
        <div className="brand">
          <Logo />
          <strong>QA Autônomo</strong>
        </div>

        <div className="picker">
          <span className="caption">Projeto</span>
          <select aria-label="Projeto" value={ws.project ?? ""} onChange={(e) => ws.setProjectId(e.target.value)}>
            {ws.projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="caption">Ambiente</span>
          <select aria-label="Ambiente" value={env?.id ?? ""} onChange={(e) => ws.setEnvId(e.target.value)}>
            {ws.envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        <ul className="nav">
          {NAV.map((n) => (
            <li key={n.page}>
              <a href={n.hash} className={`nav-item${page === n.page ? " is-active" : ""}`} aria-current={page === n.page ? "page" : undefined}>
                <Icon name={n.icon} size={19} />
                <span>{n.label}</span>
                {badge(n.page) !== undefined && <span className="nav-badge">{badge(n.page)}</span>}
                {n.page === "runs" && activeRun && <span className="live-dot" aria-label="Execução em andamento" />}
              </a>
            </li>
          ))}
        </ul>

        <div className="sidebar-foot">
          <ThemeSwitch />
          <div className="user">
            <span className="avatar" aria-hidden="true">
              {me.data.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-info">
              <strong>{me.data.email}</strong>
              <small>{me.data.role}</small>
            </span>
            <button type="button" className="icon-btn" onClick={onLogout} aria-label="Sair" title="Sair">
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <h1>{TITLES[page]}</h1>
            <span>
              {ws.projectName ?? "Nenhum projeto"}
              {env ? ` / ${env.name}` : ""}
            </span>
          </div>
          <div className="topbar-actions">
            {activeRun && (
              <button type="button" className="chip tone-info live" onClick={() => go("map")}>
                <span className="live-dot" aria-hidden="true" />
                {activeRun.status === "queued" ? "Aguardando runner" : activeRun.type === "exploration" ? `Mapeando · ${ws.graph.data?.nodes.length ?? 0} telas` : "Executando regressão"}
              </button>
            )}
            {env?.is_production && <span className="chip tone-warn">Ambientes de produção não podem ser executados.</span>}
            <button type="button" className="btn" onClick={() => ws.setReportOpen(true)} disabled={!env} title="Relatório geral do ambiente, para exportar a qualquer momento">
              <Icon name="chart" size={16} />
              Relatório
            </button>
            {page !== "settings" && (
              <>
                <button type="button" className="btn" onClick={() => void ws.runCrossref()} disabled={!env || !ws.spec || !ws.graph.data || ws.crossrefBusy}>
                  {ws.crossrefBusy ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="link" size={16} />}
                  Cruzar com a spec
                </button>
                <button type="button" className="btn" onClick={() => ws.openRunDialog("regression")} disabled={!env || env.is_production || !ws.graph.data}>
                  <Icon name="repeat" size={16} />
                  Nova regressão
                </button>
                <button type="button" className="btn primary" onClick={() => ws.openRunDialog("exploration")} disabled={!env || env.is_production}>
                  <Icon name="explore" size={16} />
                  Nova exploração
                </button>
              </>
            )}
          </div>
        </header>

        <EnvAlert />
        <div className={`page-host${page === "map" || page === "flows" ? " is-map" : ""}`}>
          {page === "overview" && <Overview />}
          {page === "product" && <ProductPage />}
          {page === "map" && <MapPage />}
          {page === "flows" && <FlowsPage />}
          {page === "specs" && <SpecsPage />}
          {page === "bugs" && <BugsPage />}
          {page === "runs" && <RunsPage />}
          {page === "settings" && (
            <Settings
              token={ws.token}
              projectId={ws.project}
              envId={env?.id}
              tab={sub}
              onTab={(t) => go("settings", t)}
              onSelectProject={ws.setProjectId}
              onSelectEnv={ws.setEnvId}
              onChanged={() => void qc.invalidateQueries()}
            />
          )}
        </div>
      </main>

      <RunDialog />
      <ReportDialog />
      {ws.specDialogOpen && ws.project && (
        <SpecDialog
          token={ws.token}
          projectId={ws.project}
          canCrossref={!!env && !!ws.graph.data}
          onCrossref={() => void ws.runCrossref()}
          onClose={() => ws.setSpecDialogOpen(false)}
        />
      )}
    </div>
  );
}
