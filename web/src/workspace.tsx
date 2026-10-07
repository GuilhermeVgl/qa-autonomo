import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  api,
  errorMessage,
  type Bug,
  type Coverage,
  type Credential,
  type Environment,
  type NodeStatus,
  type GraphData,
  type Me,
  type Pendency,
  type RunBudgetInput,
  type Project,
  type Run,
  type RunReport,
  type Spec,
} from "./api";
import type { NodeCoverage, NodeResult } from "./GraphView";
import { useRoute, type Page } from "./route";
import { useDiscoveries } from "./progress";
import { useToast } from "./ui";
import { useGraphStream } from "./useGraphStream";

type Q<T> = ReturnType<typeof useQuery<T>>;

export interface Workspace {
  token: string;
  me: Q<Me>;
  projects: Q<Project[]>;
  project: string | undefined;
  projectName: string | undefined;
  setProjectId: (id: string) => void;
  envs: Q<Environment[]>;
  env: Environment | undefined;
  setEnvId: (id: string) => void;
  credentials: Credential[] | undefined;
  graph: Q<GraphData | null>;
  runs: Q<Run[]>;
  activeRun: Run | undefined;
  /** The specs that apply to this environment: the written ones and the environment's own automatic one. */
  specs: Spec[] | undefined;
  /** Newest spec written by people (the generated sweep is a spec of its own, kept apart): what the AI cross-reference uses. */
  spec: Spec | undefined;
  /** The spec the coverage is measured against: the written one, or the automatic one when nobody wrote any. */
  coverageSpec: Spec | undefined;
  coverage: Coverage | undefined;
  pendencies: Pendency[] | undefined;
  openPendencies: Pendency[];
  bugs: Bug[] | undefined;
  /** Every open bug, of both kinds. */
  openBugs: Bug[];
  /** The open bugs the tests found, and apart from them the open findings of the security checks. */
  openFunctional: Bug[];
  openSecurity: Bug[];
  report: RunReport | undefined;
  nodeCoverage: Record<string, NodeCoverage> | undefined;
  /** The newest verdict of each screen, for coloring the map. */
  nodeResults: Record<string, NodeResult> | undefined;
  discoveries: ReturnType<typeof useDiscoveries>;
  crossrefBusy: boolean;
  startRun: (type: "exploration" | "regression", options?: RunOptions) => Promise<void>;
  /** Opens the dialog that asks which users to run as and how far to go, then starts the run. */
  openRunDialog: (type: "exploration" | "regression", specId?: string, options?: { resume?: boolean }) => void;
  runDialog: { type: "exploration" | "regression"; specId?: string; resume?: boolean } | null;
  closeRunDialog: () => void;
  runCrossref: (specId?: string) => Promise<void>;
  generateAutoSpec: () => Promise<void>;
  cancelRun: (id: string) => Promise<void>;
  refreshBugs: () => Promise<void>;
  refreshCoverage: () => Promise<void>;
  go: (page: Page, sub?: string) => void;
  specDialogOpen: boolean;
  setSpecDialogOpen: (open: boolean) => void;
  /** The general report, from any page. */
  reportOpen: boolean;
  setReportOpen: (open: boolean) => void;
}

export interface RunOptions {
  /** Limits a regression to one spec. */
  specId?: string;
  /** Users to run as (a regression) or to explore; empty or absent means every user. */
  roles?: string[];
  budget?: RunBudgetInput;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside WorkspaceProvider");
  return ws;
}

const isOpenBug = (b: Bug) => b.status === "new" || b.status === "confirmed" || b.status === "reopened";
const isSecurityBug = (b: Bug) => b.category === "security";

/** Everything the screens share: the selected project and environment, the queries around them and the actions. */
export function WorkspaceProvider({ token, onLogout, children }: { token: string; onLogout: () => void; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { go } = useRoute();
  const [projectId, setProjectId] = useState<string>();
  const [envId, setEnvId] = useState<string>();
  const [specDialogOpen, setSpecDialogOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [crossrefBusy, setCrossrefBusy] = useState(false);
  const [runDialog, setRunDialog] = useState<Workspace["runDialog"]>(null);

  const me = useQuery({ queryKey: ["me", token], queryFn: () => api<Me>("/api/v1/me", token) });
  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) onLogout();
  }, [unauthorized, onLogout]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/api/v1/projects", token), enabled: me.isSuccess });
  const project = projectId ?? projects.data?.[0]?.id;
  const envs = useQuery({
    queryKey: ["envs", project],
    queryFn: () => api<Environment[]>(`/api/v1/projects/${project}/environments`, token),
    enabled: !!project,
  });
  const env = envs.data?.find((e) => e.id === envId) ?? envs.data?.[0];
  const credentials = useQuery({
    queryKey: ["credentials", env?.id],
    queryFn: () => api<Credential[]>(`/api/v1/environments/${env?.id}/credentials`, token),
    enabled: !!env,
  }).data;

  const activeRunRef = useRef<Run | undefined>(undefined);
  const graph = useQuery({
    queryKey: ["graph", env?.id],
    queryFn: async () => {
      try {
        return await api<GraphData>(`/api/v1/environments/${env?.id}/graph`, token);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null; // no exploration yet
        throw e;
      }
    },
    enabled: !!env,
    // the live stream is the fast path; polling covers a stream that is down or buffered by a proxy
    refetchInterval: () => (activeRunRef.current ? 2500 : false),
  });
  const nodeStatus = useQuery({
    queryKey: ["node-status", env?.id, graph.data?.graph.id],
    queryFn: () => api<NodeStatus[]>(`/api/v1/environments/${env?.id}/node-status`, token),
    enabled: !!env && !!graph.data,
    refetchInterval: () => (activeRunRef.current ? 4000 : false),
  }).data;
  const runs = useQuery({
    queryKey: ["runs", env?.id],
    queryFn: () => api<Run[]>(`/api/v1/environments/${env?.id}/runs`, token),
    enabled: !!env,
    refetchInterval: 3000,
  });
  const activeRun = runs.data?.find((r) => r.status === "queued" || r.status === "running");
  activeRunRef.current = activeRun;

  const allSpecs = useQuery({
    queryKey: ["specs", project],
    queryFn: () => api<Spec[]>(`/api/v1/projects/${project}/specs`, token),
    enabled: !!project,
  }).data;
  // the automatic spec describes the map of ONE environment: another environment's sweep is not a spec of this one
  const specs = allSpecs?.filter((s) => s.source_type !== "auto" || !s.environment_id || s.environment_id === env?.id);
  const spec = specs?.find((s) => s.source_type !== "auto"); // newest version first; the generated sweep is not "the spec"
  const coverageSpec = spec ?? specs?.find((s) => s.source_type === "auto");
  const graphId = graph.data?.graph.id;
  const coverage = useQuery({
    queryKey: ["coverage", coverageSpec?.id, graphId],
    queryFn: () => api<Coverage>(`/api/v1/specs/${coverageSpec?.id}/coverage?graph_id=${graphId}`, token),
    enabled: !!coverageSpec && !!graphId,
  }).data;
  const pendencies = useQuery({
    queryKey: ["pendencies", coverageSpec?.id],
    queryFn: () => api<Pendency[]>(`/api/v1/specs/${coverageSpec?.id}/pendencies`, token),
    enabled: !!coverageSpec,
  }).data;
  const bugs = useQuery({
    queryKey: ["bugs", project],
    queryFn: () => api<Bug[]>(`/api/v1/projects/${project}/bugs`, token),
    enabled: !!project,
  }).data;
  const finishedRun = runs.data?.find((r) => r.status === "succeeded" || r.status === "failed");
  const report = useQuery({
    queryKey: ["report", finishedRun?.id],
    queryFn: () => api<RunReport>(`/api/v1/runs/${finishedRun?.id}/report`, token),
    enabled: !!finishedRun,
  }).data;

  // when a run ends, pull the final state of everything it touched and say so
  const hadActiveRun = useRef<Run | undefined>(undefined);
  useEffect(() => {
    const before = hadActiveRun.current;
    if (before && !activeRun) {
      for (const key of ["graph", "coverage", "node-status", "bugs", "pendencies", "report", "runs"]) void qc.invalidateQueries({ queryKey: [key] });
      const ended = runs.data?.find((r) => r.id === before.id);
      if (ended?.status === "succeeded") toast.show({ kind: "success", title: before.type === "exploration" ? "Mapeamento concluído" : "Regressão concluída" });
      else if (ended?.status === "failed") toast.show({ kind: "error", title: "O run falhou", text: "Veja os detalhes em Execuções." });
    }
    hadActiveRun.current = activeRun;
  }, [activeRun, qc, runs.data, toast]);
  const discoveries = useDiscoveries(graph.data?.graph.id, graph.data?.nodes);

  const refetchGraph = useCallback(() => void qc.invalidateQueries({ queryKey: ["graph"] }), [qc]);
  useGraphStream(graph.data?.graph.id, token, refetchGraph);

  const refreshBugs = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["bugs"] }), qc.invalidateQueries({ queryKey: ["runs"] })]);
  };
  const refreshCoverage = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["coverage"] }), qc.invalidateQueries({ queryKey: ["pendencies"] })]);
  };

  async function startRun(type: "exploration" | "regression", options: RunOptions = {}) {
    if (!env) return;
    const { specId, roles, budget } = options;
    const budgetBody = { ...budget, ...(roles && roles.length > 0 ? { roles } : {}) };
    try {
      await api<Run>(`/api/v1/environments/${env.id}/runs`, token, {
        method: "POST",
        body: JSON.stringify({ type, ...(specId ? { spec_id: specId } : {}), ...(Object.keys(budgetBody).length > 0 ? { budget: budgetBody } : {}) }),
      });
      await Promise.all([qc.invalidateQueries({ queryKey: ["graph"] }), qc.invalidateQueries({ queryKey: ["runs"] })]);
      toast.show({
        kind: "success",
        title: type === "exploration" ? "Exploração iniciada" : "Regressão iniciada",
        text:
          type === "exploration"
            ? budget?.resume
              ? "Continuando de onde parou: o que já foi examinado não é refeito."
              : roles && roles.length > 0
                ? `Explorando só: ${roles.join(", ")}. O mapa dos outros usuários continua como estava.`
                : "Acompanhe o mapa sendo montado ao vivo."
            : roles && roles.length > 0
              ? `Testando como: ${roles.join(", ")}.`
              : specId
                ? "Só as telas e formulários desta especificação serão testados."
                : "Acompanhe o andamento no mapa.",
      });
      go("map");
    } catch (e) {
      toast.show({ kind: "error", title: "Não foi possível iniciar o run", text: errorMessage(e) });
    }
  }

  async function runCrossref(specId?: string) {
    if (!env || crossrefBusy) return;
    setCrossrefBusy(true);
    const working = toast.loading("Cruzando os requisitos com o mapa…", "A IA liga cada requisito às telas. Pode levar alguns instantes.");
    try {
      const r = await api<{ links?: number; pendencies_created?: number }>(`/api/v1/environments/${env.id}/crossref`, token, { method: "POST", body: JSON.stringify(specId ? { spec_id: specId } : {}) });
      await refreshCoverage();
      const links = r.links ?? 0;
      const pend = r.pendencies_created ?? 0;
      working.done("Cruzamento concluído", `${links} ${links === 1 ? "ligação" : "ligações"} · ${pend} ${pend === 1 ? "pendência nova" : "pendências novas"}`);
    } catch (e) {
      working.fail("Não foi possível cruzar com a spec", errorMessage(e));
    } finally {
      setCrossrefBusy(false);
    }
  }

  async function generateAutoSpec() {
    if (!env) return;
    try {
      const r = await api<{ created: number; updated: number; removed: number; unchanged: number }>(`/api/v1/environments/${env.id}/specs/auto`, token, { method: "POST", body: JSON.stringify({}) });
      await Promise.all([qc.invalidateQueries({ queryKey: ["specs"] }), qc.invalidateQueries({ queryKey: ["requirements"] }), qc.invalidateQueries({ queryKey: ["coverage"] })]);
      toast.show({ kind: "success", title: "Especificação automática atualizada", text: `${r.created} nova(s), ${r.updated} alterada(s), ${r.removed} removida(s), ${r.unchanged} sem mudança.` });
    } catch (e) {
      toast.show({ kind: "error", title: "Não foi possível gerar a especificação", text: errorMessage(e) });
    }
  }

  async function cancelRun(id: string) {
    try {
      await api(`/api/v1/runs/${id}/cancel`, token, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["runs"] });
      toast.show({ kind: "info", title: "Run cancelado" });
    } catch (e) {
      toast.show({ kind: "error", title: "Não foi possível cancelar", text: errorMessage(e) });
    }
  }

  const openPendencies = pendencies?.filter((p) => p.status === "open") ?? [];
  // covered = any spec (the generated one included) has a requirement linked to the screen; a pending question wins
  const nodeCoverage: Record<string, NodeCoverage> | undefined = graph.data ? {
    ...Object.fromEntries(graph.data.nodes.map((n) => [n.id, (n.requirement_count ?? 0) > 0 ? "covered" : "no_spec"] as const)),
    ...Object.fromEntries(openPendencies.flatMap((p) => (p.node_id ? [[p.node_id, "pending" as const]] : []))),
  } : undefined;
  const nodeResults: Record<string, NodeResult> | undefined = nodeStatus && Object.fromEntries(nodeStatus.map((s) => [s.node_id, s.status]));

  const value: Workspace = {
    token,
    me,
    projects,
    project,
    projectName: projects.data?.find((p) => p.id === project)?.name,
    setProjectId: (id) => (setProjectId(id), setEnvId(undefined)),
    envs,
    env,
    setEnvId,
    credentials,
    graph,
    runs,
    activeRun,
    specs,
    spec,
    coverageSpec,
    coverage,
    pendencies,
    openPendencies,
    bugs,
    openBugs: bugs?.filter(isOpenBug) ?? [],
    openFunctional: bugs?.filter((b) => isOpenBug(b) && !isSecurityBug(b)) ?? [],
    openSecurity: bugs?.filter((b) => isOpenBug(b) && isSecurityBug(b)) ?? [],
    report,
    nodeCoverage,
    nodeResults,
    discoveries,
    crossrefBusy,
    startRun,
    openRunDialog: (type, specId, options) => setRunDialog({ type, ...(specId ? { specId } : {}), ...(options?.resume ? { resume: true } : {}) }),
    runDialog,
    closeRunDialog: () => setRunDialog(null),
    runCrossref,
    generateAutoSpec,
    cancelRun,
    refreshBugs,
    refreshCoverage,
    go,
    specDialogOpen,
    setSpecDialogOpen,
    reportOpen,
    setReportOpen,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
