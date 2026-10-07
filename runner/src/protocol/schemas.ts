import { z } from "zod";

// Runner <-> control plane contract (CLAUDE.md, seção 10). Everything crossing the wire is validated.

export const jobSchema = z.object({
  run_id: z.string().uuid(),
  attempt: z.number().int().positive(),
  graph_id: z.string().uuid().nullable(),
  type: z.enum(["exploration", "regression"]),
  budget: z.object({
    max_pages: z.number().int().positive(),
    max_depth: z.number().int().positive(),
    max_seconds: z.number().int().positive(),
    max_llm_calls: z.number().int().nonnegative().default(0),
    /** Browser actions (clicks, form submissions) the exploration may spend; 0 keeps it to following links. */
    max_actions: z.number().int().nonnegative().optional(),
    /** Regression: browsers checking screens at once for each user (default 1; some apps end the first session on a new login). */
    concurrency: z.number().int().positive().optional(),
    /** Turns the security checks of the run off (they run by default). */
    no_security: z.boolean().optional(),
  }),
  environment: z.object({
    kind: z.enum(["web", "terminal"]).optional(), // absent = web
    terminal: z.object({ binary: z.string().min(1), image: z.string().optional() }).optional(),
    device: z.string().min(1).optional(), // set: emulate this device (executor mobile_web)
    base_url: z.string().min(1), // terminal environments carry a terminal:// pseudo URL
    allowed_hosts: z.array(z.string().min(1)),
    destructive_policy: z.enum(["block", "confirm", "allow"]),
  }),
  // exploration that continues an interrupted one: the screens already examined, so they are not examined again
  resume: z
    .object({
      generation: z.number().int().nonnegative(),
      known: z.array(
        z.object({
          fingerprint: z.string().min(1),
          app_role: z.string(),
          followed: z
            .array(z.object({ url: z.string().min(1), label: z.string(), type: z.enum(["submit", "search", "click"]), intent: z.enum(["create", "save", "search", "filter", "edit", "open", "navigate", "delete", "external", "toggle", "never", "other"]) }))
            .optional(),
        }),
      ),
    })
    .optional(),
  // regression only: the covered nodes to test
  targets: z
    .array(
      z.object({
        kind: z.enum(["page", "endpoint", "command"]).optional(), // absent = page (older control planes)
        node_id: z.string().uuid(),
        fingerprint: z.string().min(1),
        url: z.string().url().optional(), // page
        label: z.string(),
        app_role: z.string(),
        requirement_keys: z.array(z.string()),
        // endpoint: the call and its contract
        method: z.string().optional(),
        path: z.string().optional(),
        query: z.record(z.string(), z.string()).optional(),
        status: z.number().int().optional(),
        schema: z.record(z.string(), z.unknown()).optional(),
        body_required: z.boolean().optional(),
        // command: arguments after the binary, and the shape of its --help when it was explored
        args: z.array(z.string()).optional(),
        help_signature: z.string().optional(),
        // page: where the security checks can try injections without changing anything
        probes: z.array(z.object({ url: z.string().url(), params: z.array(z.string()) })).optional(),
      }),
    )
    .optional(),
  credentials: z.array(
    z.object({
      app_role: z.string(),
      kind: z.enum(["login", "api_token"]),
      payload: z.record(z.string(), z.string()),
    }),
  ),
});
export type Job = z.infer<typeof jobSchema>;

export const registerResponseSchema = z.object({ runner_id: z.string(), token: z.string().min(1) });
export const heartbeatResponseSchema = z.object({ cancel: z.boolean() });

export type RunnerEvent =
  | {
      seq: number;
      type: "step_started";
      payload: {
        key: string;
        node_id?: string;
        /** Names the screen by fingerprint when the run has no ids yet, as in an exploration. */
        node_fingerprint?: string;
        executor: "browser" | "mobile_web" | "api" | "terminal";
        expected: string;
        input: Record<string, unknown>;
        /** Marks the step as a security check; a failure is a bug of its own kind. */
        security?: { check: string; severity: "critical" | "high" | "normal"; scope?: string };
      };
    }
  | {
      seq: number;
      type: "step_finished";
      payload: { key: string; result: "pass" | "fail" | "error" | "skipped"; actual: string; artifacts?: ArtifactRef[] };
    }
  | {
      seq: number;
      type: "node_discovered";
      payload: { fingerprint: string; kind: "page" | "modal" | "endpoint" | "command"; label: string; app_role?: string; metadata?: Record<string, unknown> };
    }
  | {
      seq: number;
      /** The picture of a screen found earlier in the same run (its node must already have been sent). */
      type: "node_thumbnail";
      payload: { fingerprint: string; artifact: ArtifactRef };
    }
  | {
      seq: number;
      type: "edge_discovered";
      payload: { key: string; from_fingerprint: string; to_fingerprint: string; action: Record<string, unknown>; app_role?: string };
    };

export type ArtifactKind = "screenshot" | "video" | "trace" | "har" | "console" | "http" | "stdout";

export interface ArtifactRef {
  kind: ArtifactKind;
  content_type: string;
  storage_key: string;
}

export interface RunSummary {
  [key: string]: unknown;
}

export const chatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
