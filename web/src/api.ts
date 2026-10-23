import { isExpired } from "./oidc";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ? `API respondeu ${status}: ${detail}` : `API respondeu ${status}`);
  }
}

export interface Me {
  email: string;
  role: string;
}
export interface Project {
  id: string;
  name: string;
}
export interface Environment {
  id: string;
  name: string;
  base_url: string;
  is_production: boolean;
  kind?: "web" | "terminal";
  device?: string | null;
  destructive_policy?: "block" | "confirm" | "allow";
  allowed_hosts?: string[];
  binary?: string | null;
  image?: string | null;
}
export interface Credential {
  id: string;
  app_role: string;
  kind: string;
}
export interface Capture {
  id: string;
  status: string;
  app_role: string;
  start_url: string;
}
export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  app_roles: string[];
  metadata: Record<string, unknown>;
  /** Requirements (of any spec) linked to this node; above zero means it is covered. */
  requirement_count?: number;
  /** The first requirements that cover the node. */
  requirement_keys?: string[];
  /** The node has a picture of its screen, at /api/v1/nodes/{id}/thumbnail. */
  has_thumbnail?: boolean;
}
/** What the newest testing run said about a node (worst result of its checks). */
export interface NodeStatus {
  node_id: string;
  run_id: string;
  status: "pass" | "fail" | "error" | "skipped";
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  at: string;
}
export interface GraphEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  key: string;
  /** What the agent did to go from one node to the other: a link, a click, a form, a request. */
  action?: Record<string, unknown>;
  /** The user whose exploration found this edge. */
  app_roles?: string[];
}
export interface GraphData {
  graph: { id: string; version: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface Run {
  id: string;
  type: string;
  trigger?: "manual" | "schedule" | "ci";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  summary: Record<string, unknown>;
  budget?: { max_pages: number; max_depth: number; max_seconds: number; max_llm_calls: number; max_actions?: number; spec_id?: string; roles?: string[]; resume?: boolean; no_security?: boolean };
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new ApiError(res.status, detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const TOKEN_KEY = "qa_token";

export function loadToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && isExpired(token)) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the session just won't persist
  }
}

export interface Spec {
  id: string;
  version: number;
  title: string;
  source_type?: "text" | "openapi" | "auto";
  /** For the automatic spec: the environment whose map it describes. */
  environment_id?: string;
}
export interface Requirement {
  id?: string;
  key: string;
  text: string;
  criticality: "critical" | "high" | "normal";
  status?: "new" | "changed" | "unchanged";
  category?: "business" | "technical";
  /** Why the text may be hard to test: "vago", "curto", "composto", "parecido com REQ-X". */
  quality?: string[];
}
export interface SpecResult {
  spec: Spec;
  requirements: Requirement[];
  removed: Requirement[];
  skipped?: string[];
}
export interface Coverage {
  requirements: { key: string; text: string; criticality: string; status: "covered" | "pending" | "unmatched"; node_ids: string[] }[];
  nodes: { node_id: string; label: string; status: "covered" | "no_spec"; requirement_keys: string[] }[];
}

export interface CapabilityNode {
  id: string;
  label: string;
  covered: boolean;
  status: "pass" | "fail" | "error" | "skipped" | "untested";
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  criticality: "critical" | "high" | "normal";
  source: "agent" | "human";
  nodes_total: number;
  nodes_covered: number;
  nodes_tested: number;
  status: "pass" | "fail" | "error" | "skipped" | "untested";
  nodes: CapabilityNode[];
}

export interface CapabilityResponse {
  graph_id: string;
  generated_at: string;
  capabilities: Capability[];
}
export interface Pendency {
  id: string;
  requirement_id: string;
  node_id: string | null;
  question: string;
  answer: string | null;
  status: "open" | "answered" | "dismissed";
}

export interface AuthConfig {
  mode: "oidc" | "dev";
  issuer?: string;
  client_id?: string;
}

export async function loadAuthConfig(): Promise<AuthConfig> {
  const res = await fetch("/api/v1/auth/config");
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as AuthConfig;
}

export interface HistoryItem {
  id: string;
  run_id: string;
  run_type: string;
  run_status: string;
  result: "pass" | "fail" | "error" | "skipped" | null;
  expected: string;
  actual: string;
  user?: string;
  started_at: string | null;
  artifacts: { id: string; kind: string; content_type: string; size: number }[];
}

export interface RunStep {
  id: string;
  node_id: string | null;
  executor: string;
  input: Record<string, unknown> | null;
  expected: string;
  actual: string;
  result: "pass" | "fail" | "error" | "skipped" | null;
  /** Who the check ran as. */
  user?: string;
  /** Set when the step is a security check: which one, how serious a failure is and what it looked at. */
  security?: { check: string; severity: "critical" | "high" | "normal"; scope?: string };
  artifacts: HistoryItem["artifacts"];
}

export interface StepsQuery {
  /** pass, fail, error, skipped, running. Empty means all. */
  results?: string[];
  /** The user a step ran as; "" is the steps that belong to none. Undefined means every user. */
  user?: string;
  /** Only the security checks. Without it the list is the tests of the run, which is what a run's steps are about. */
  kind?: "security";
  offset?: number;
  limit?: number;
}

/** One page of the steps of a run, problems first, and how many there are in all with those filters. */
export async function fetchSteps(token: string, runId: string, q: StepsQuery = {}): Promise<{ items: RunStep[]; total: number }> {
  const params = new URLSearchParams();
  if (q.results && q.results.length > 0) params.set("result", q.results.join(","));
  if (q.user !== undefined) params.set("user", q.user);
  if (q.kind) params.set("kind", q.kind);
  if (q.offset) params.set("offset", String(q.offset));
  params.set("limit", String(q.limit ?? 50));
  const res = await fetch(`/api/v1/runs/${runId}/steps?${params}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status);
  const items = (await res.json()) as RunStep[];
  return { items, total: Number(res.headers.get("X-Total-Count") ?? items.length) };
}

/** Fetches evidence with the session token (the API serves it only to authenticated users). */
export async function fetchBlob(path: string, token: string): Promise<Blob> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status);
  return res.blob();
}

export interface Bug {
  id: string;
  title: string;
  status: "new" | "confirmed" | "fixed" | "false_positive" | "reopened";
  severity: "critical" | "high" | "normal";
  /** The users the defect was seen for. */
  users?: string[];
  /** What found it: a test that failed ("functional", the default) or a security check ("security"). */
  category?: "functional" | "security";
  check?: string;
}

export interface RunReport {
  run: { id: string; type: string; status: string; duration_seconds: number };
  steps: Record<string, number>;
  /** Who was tested: results per user (an empty user is a check that belongs to none, like an API call). */
  users?: { user: string; passed: number; failed: number; errored: number; skipped: number }[];
  requirements: { key: string; outcome: string; criticality: string; by_user?: Record<string, string> }[];
  /** What the security checks of the run came to; the failures by how serious they are. */
  security?: { checks: number; passed: number; failed: number; by_severity: { critical: number; high: number; normal: number } };
  bugs: { new: Bug[]; recurring: Bug[]; fixed: Bug[] };
  cost: { llm_calls: number; tokens_in: number; tokens_out: number; cost: number };
}

/** Turns an API failure into something a person can act on. */
export function errorMessage(e: unknown, fallback = "Não foi possível concluir a ação."): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.status === 503) return "O modelo de IA não está configurado neste servidor.";
  if (e.status === 502) return "O modelo de IA respondeu algo que não deu para usar. Tente de novo.";
  if (e.status === 401) return "Sua sessão expirou. Entre novamente.";
  return e.detail ?? fallback;
}

/** What the person may set when starting a run; whatever is left out takes the server default. */
export interface RunBudgetInput {
  max_pages?: number;
  max_depth?: number;
  max_seconds?: number;
  max_llm_calls?: number;
  max_actions?: number;
  /** Regression: browsers at once per user. */
  concurrency?: number;
  /** Exploration: continue the last (interrupted) one on the same map instead of starting a new one. */
  resume?: boolean;
  /** Turns the security checks off for the run; they run by default. */
  no_security?: boolean;
}
