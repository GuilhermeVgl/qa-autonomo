import { runJob } from "./agent/job.js";
import { LlmAnalyst } from "./agent/analyst.js";
import { LlmMeter } from "./agent/meter.js";
import { LlmPlanner } from "./agent/planner.js";
import { loadConfig } from "./config.js";
import { runCapture } from "./capture/remote.js";
import { BrowserDriver } from "./executors/browser/driver.js";
import { createCommandRunner } from "./executors/terminal/exec.js";
import type { Driver } from "./agent/explorer.js";
import { ControlPlaneClient } from "./protocol/client.js";
import { HttpUploader } from "./protocol/uploader.js";

const VERSION = "0.0.1";
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));

// Runner is stateless and outbound-only (CLAUDE.md, seção 4.2): register (or reuse a token), then lease jobs forever.
async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const token =
    cfg.runnerToken ??
    (await ControlPlaneClient.register(cfg.controlPlaneUrl, {
      bootstrapToken: cfg.bootstrapToken as string, // guaranteed by config validation
      name: cfg.name,
      labels: cfg.labels,
      version: VERSION,
    }));
  const client = new ControlPlaneClient(cfg.controlPlaneUrl, token);
  log("runner started", { controlPlaneUrl: cfg.controlPlaneUrl, labels: cfg.labels });

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));

  // A second, independent loop handles remote-browser capture (a person logging in), so it never blocks job leasing.
  void captureLoop(client, () => stopping);

  while (!stopping) {
    try {
      const job = await client.lease(30_000);
      if (!job) continue;
      log("job leased", { run_id: job.run_id, attempt: job.attempt });
      // terminal jobs run the CLI inside this (ephemeral) container, with no network; they need no browser
      const terminal = job.environment.kind === "terminal" ? job.environment.terminal : undefined;
      const command = terminal ? await createCommandRunner(terminal.binary) : undefined;
      const driver: Driver & { blockedRequests: Set<string>; close(): Promise<void> } = terminal
        ? { newSession: () => Promise.reject(new Error("no browser for terminal jobs")), blockedRequests: new Set(), close: async () => undefined }
        : await BrowserDriver.launch({ ...job.environment, security: !job.budget.no_security });
      // LLM-guided exploration is bounded by the run budget; without a gateway (503) it silently stays deterministic.
      // The calls are one allowance shared by link ranking and the reading of pages (when the run may interact).
      const meter = new LlmMeter(job.budget.max_llm_calls);
      const chat = (m: { role: "system" | "user"; content: string }[]) => client.chat(job.run_id, m);
      const planner = job.budget.max_llm_calls > 0 ? new LlmPlanner({ chat, maxCalls: job.budget.max_llm_calls, meter }) : undefined;
      const analyst = job.budget.max_llm_calls > 0 && (job.budget.max_actions ?? 0) > 0 ? new LlmAnalyst({ chat, meter }) : undefined;
      try {
        await runJob({
          client,
          job,
          driver,
          planner,
          analyst,
          ...(command ? { command } : {}),
          uploader: new HttpUploader(cfg.controlPlaneUrl, token, job.run_id),
          extraSummary: () => ({ blocked_requests: [...driver.blockedRequests], llm_calls: meter.used }),
        });
      } finally {
        await driver.close();
      }
      log("job finished", { run_id: job.run_id });
    } catch (err) {
      log("loop error", { error: err instanceof Error ? err.message : String(err) });
      await new Promise((r) => setTimeout(r, 5_000)); // back off, never crash-loop the control plane
    }
  }
}

async function captureLoop(client: ControlPlaneClient, stopping: () => boolean): Promise<void> {
  while (!stopping()) {
    try {
      const session = await client.leaseCapture(25_000);
      if (!session) continue;
      log("capture leased", { capture_id: session.id });
      await runCapture(client, session);
      log("capture finished", { capture_id: session.id });
    } catch (err) {
      log("capture loop error", { error: err instanceof Error ? err.message : String(err) });
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

main().catch((err: unknown) => {
  log("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});