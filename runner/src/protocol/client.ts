import { chatResponseSchema, heartbeatResponseSchema, jobSchema, registerResponseSchema, type Job, type RunSummary, type RunnerEvent } from "./schemas.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`control plane responded ${status} for ${path}`);
  }
}

/** Outbound-only client for /runner/v1. Never sends credentials of the tested app anywhere but the job it received. */
export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static async register(
    baseUrl: string,
    input: { bootstrapToken: string; name: string; labels: string[]; version: string },
  ): Promise<string> {
    const res = await post(baseUrl, "/runner/v1/register", undefined, {
      bootstrap_token: input.bootstrapToken,
      name: input.name,
      labels: input.labels,
      version: input.version,
    });
    return registerResponseSchema.parse(await res.json()).token;
  }

  /** Long-polls for a job; null when none is available. */
  async lease(waitMs: number): Promise<Job | null> {
    const res = await post(this.baseUrl, `/runner/v1/jobs/lease?wait=${waitMs}`, this.token);
    if (res.status === 204) return null;
    return jobSchema.parse(await res.json());
  }

  async heartbeat(runId: string): Promise<{ cancel: boolean }> {
    const res = await post(this.baseUrl, `/runner/v1/jobs/${runId}/heartbeat`, this.token);
    return heartbeatResponseSchema.parse(await res.json());
  }

  /** Chat completion through the control plane's LLM gateway (the runner never sees LLM credentials). */
  async chat(runId: string, messages: { role: "system" | "user"; content: string }[], task = "explore"): Promise<string> {
    const res = await post(this.baseUrl, "/runner/v1/llm/chat/completions", this.token, { messages, response_format: { type: "json_object" } }, {
      "x-qa-run-id": runId,
      "x-qa-task": task,
    });
    return (chatResponseSchema.parse(await res.json()).choices[0] as { message: { content: string } }).message.content;
  }

  async sendEvents(runId: string, events: RunnerEvent[]): Promise<void> {
    await post(this.baseUrl, `/runner/v1/jobs/${runId}/events`, this.token, { events });
  }

  async complete(runId: string, status: "succeeded" | "failed", summary: RunSummary): Promise<void> {
    await post(this.baseUrl, `/runner/v1/jobs/${runId}/complete`, this.token, { status, summary });
  }
}

async function post(baseUrl: string, path: string, token: string | undefined, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, path.split("?")[0] ?? path);
  return res;
}
