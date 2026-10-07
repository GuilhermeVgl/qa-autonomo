import { Ajv, type ValidateFunction } from "ajv";
import { isAllowedUrl, type DestructivePolicy } from "../../agent/guards.js";

/** What the control plane sends for an `endpoint` node: the call to make and the contract to check. */
export interface EndpointTarget {
  method: string;
  path: string; // path parameters already substituted
  query: Record<string, string>;
  status: number;
  schema?: Record<string, unknown> | undefined;
  body_required: boolean;
}

export interface ApiResponse {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  url: string;
  durationMs: number;
}

export type CallOutcome =
  | { kind: "response"; response: ApiResponse }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

export interface CallInput {
  baseUrl: string;
  allowedHosts: string[];
  target: EndpointTarget;
  token?: string | undefined;
  policy: DestructivePolicy;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const MAX_BODY_BYTES = 1_048_576;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Calls one endpoint. Scope is enforced here (hosts outside allowed_hosts are never contacted, redirects are not
 * followed), mutating methods obey the environment's destructive policy, and operations that need a request body
 * are skipped because generating bodies is not supported yet.
 */
export async function callEndpoint(input: CallInput): Promise<CallOutcome> {
  const { target } = input;
  const url = buildUrl(input.baseUrl, target);
  if (!isAllowedUrl(url, input.allowedHosts)) return { kind: "skipped", reason: "target is outside the allowed hosts" };
  if (!SAFE_METHODS.has(target.method) && input.policy !== "allow") {
    return { kind: "skipped", reason: `${target.method} changes data and the environment policy is ${input.policy}` };
  }
  if (target.body_required) return { kind: "skipped", reason: "the operation needs a request body, which is not generated yet" };

  const started = Date.now();
  try {
    const res = await (input.fetchFn ?? fetch)(url, {
      method: target.method,
      redirect: "manual", // a redirect could leave the allowed hosts
      headers: { accept: "application/json", ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    const { body, truncated } = await readCapped(res);
    return {
      kind: "response",
      response: { status: res.status, contentType: res.headers.get("content-type") ?? "", body, truncated, url, durationMs: Date.now() - started },
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function buildUrl(baseUrl: string, t: EndpointTarget): string {
  const query = new URLSearchParams(t.query).toString();
  return baseUrl.replace(/\/+$/, "") + t.path + (query ? `?${query}` : "");
}

async function readCapped(res: Response): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > MAX_BODY_BYTES) {
      chunks.push(value.slice(0, MAX_BODY_BYTES - size));
      size = MAX_BODY_BYTES;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return { body: new TextDecoder().decode(buf), truncated };
}

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction>();

function validator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(key, v);
  }
  return v;
}

/** Verdict of a response against the contract: expected status and, when there is a schema, a conforming JSON body. */
export function checkContract(t: EndpointTarget, r: ApiResponse): { result: "pass" | "fail"; actual: string } {
  if (r.status !== t.status) return { result: "fail", actual: `HTTP ${r.status}, expected ${t.status}` };
  if (!t.schema) return { result: "pass", actual: `HTTP ${r.status}` };
  if (!/json/i.test(r.contentType)) return { result: "fail", actual: `HTTP ${r.status}, expected a JSON body but got ${r.contentType || "no content type"}` };
  let data: unknown;
  try {
    data = JSON.parse(r.body);
  } catch {
    return { result: "fail", actual: `HTTP ${r.status}, body is not valid JSON${r.truncated ? " (truncated)" : ""}` };
  }
  const validate = validator(t.schema);
  if (validate(data)) return { result: "pass", actual: `HTTP ${r.status}, body matches the contract` };
  const e = validate.errors?.[0];
  return { result: "fail", actual: `HTTP ${r.status}, body violates the contract: ${e?.instancePath || "/"} ${e?.message ?? "invalid"}` };
}
