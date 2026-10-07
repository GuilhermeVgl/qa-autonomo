import { z } from "zod";

const schema = z
  .object({
    CONTROL_PLANE_URL: z.string().url(),
    RUNNER_TOKEN: z.string().min(1).optional(),
    RUNNER_BOOTSTRAP_TOKEN: z.string().min(1).optional(),
    RUNNER_NAME: z.string().min(1).default("runner"),
    RUNNER_LABELS: z.string().default(""),
  })
  .refine((e) => e.RUNNER_TOKEN || e.RUNNER_BOOTSTRAP_TOKEN, { message: "set RUNNER_TOKEN or RUNNER_BOOTSTRAP_TOKEN" });

export interface RunnerConfig {
  controlPlaneUrl: string;
  /** Token of an already registered runner. */
  runnerToken: string | undefined;
  /** Used to register on startup when there is no runner token. */
  bootstrapToken: string | undefined;
  name: string;
  labels: string[];
}

export function loadConfig(env: Record<string, string | undefined>): RunnerConfig {
  const e = schema.parse(env);
  return {
    controlPlaneUrl: e.CONTROL_PLANE_URL,
    runnerToken: e.RUNNER_TOKEN,
    bootstrapToken: e.RUNNER_BOOTSTRAP_TOKEN,
    name: e.RUNNER_NAME,
    labels: e.RUNNER_LABELS.split(",").map((l) => l.trim()).filter(Boolean),
  };
}
