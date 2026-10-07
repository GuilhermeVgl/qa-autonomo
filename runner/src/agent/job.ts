import type { Job, RunSummary, RunnerEvent } from "../protocol/schemas.js";
import type { CommandRunner } from "../executors/terminal/exec.js";
import { explore, type Driver } from "./explorer.js";
import { exploreTerminal } from "./terminal.js";
import { runRegression, type Uploader } from "./regression.js";
import type { Analyst } from "./interactive.js";
import type { Planner } from "./planner.js";
import { EventSink } from "./sink.js";

/** The slice of ControlPlaneClient a job needs; lets tests plug a fake. */
export interface JobClient {
  heartbeat(runId: string): Promise<{ cancel: boolean }>;
  sendEvents(runId: string, events: RunnerEvent[]): Promise<void>;
  complete(runId: string, status: "succeeded" | "failed", summary: RunSummary): Promise<void>;
}

export interface RunJobInput {
  client: JobClient;
  job: Job;
  driver: Driver;
  heartbeatMs?: number;
  /** How often buffered events are sent while the job runs (default 1 s). */
  flushMs?: number;
  planner?: Planner;
  /** Reads pages with the LLM during interactive exploration. */
  analyst?: Analyst;
  /** Evidence upload for regression runs. */
  uploader?: Uploader;
  /** The CLI under test, for terminal environments. */
  command?: CommandRunner;
  /** Executor-specific data merged into the summary (read after the exploration ends). */
  extraSummary?: () => RunSummary;
}

/** Runs one leased job: heartbeats in the background, streams events, reports the result. */
export async function runJob(input: RunJobInput): Promise<void> {
  const { client, job, driver } = input;
  let cancelled = false;
  const timer = setInterval(() => {
    client.heartbeat(job.run_id).then(
      (r) => {
        if (r.cancel) cancelled = true;
      },
      () => undefined, // a missed heartbeat is retried on the next tick; the lease only expires after 60s
    );
  }, input.heartbeatMs ?? 20_000);

  const sink = new EventSink((events) => client.sendEvents(job.run_id, events));
  const stopAutoFlush = sink.startAutoFlush(input.flushMs ?? 1000);
  try {
    const terminal = job.environment.kind === "terminal";
    if (terminal && !input.command) throw new Error("terminal job without a command runner");
    const summary =
      job.type === "regression"
        ? await runRegression({
            driver,
            sink,
            environment: job.environment,
            credentials: job.credentials,
            targets: job.targets ?? [],
            uploader: input.uploader ?? { upload: () => Promise.reject(new Error("no uploader configured")) },
            budget: job.budget,
            shouldStop: () => cancelled,
            ...(input.command ? { command: input.command } : {}),
          })
        : terminal && input.command && job.environment.terminal
          ? await exploreTerminal({
              binary: job.environment.terminal.binary,
              runner: input.command,
              sink,
              policy: job.environment.destructive_policy,
              budget: job.budget,
              shouldStop: () => cancelled,
            })
        : await explore({
            driver,
            sink,
            environment: job.environment,
            credentials: job.credentials,
            budget: job.budget,
            shouldStop: () => cancelled,
            planner: input.planner,
            ...(input.analyst ? { analyst: input.analyst } : {}),
            ...(input.uploader ? { uploader: input.uploader } : {}),
            ...(job.resume ? { resume: job.resume } : {}),
          });
    stopAutoFlush();
    await sink.flush();
    if (cancelled) return; // cancelled server-side already; completing would be rejected
    // a run that could not even start (application down, nobody could log in) did not find "nothing": it did not run.
    // It fails with the reason, and what it reports is that, never a bug in every screen
    const blocked = "blocked" in summary ? summary.blocked : undefined;
    const done = "pages" in summary ? summary.pages : "steps" in summary ? summary.steps : 1;
    if (blocked && done === 0) {
      await client.complete(job.run_id, "failed", { ...summary, ...input.extraSummary?.(), error: blocked.message });
      return;
    }
    await client.complete(job.run_id, "succeeded", { ...summary, ...input.extraSummary?.() });
  } catch (err) {
    if (cancelled) return;
    await client.complete(job.run_id, "failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    stopAutoFlush();
    clearInterval(timer);
  }
}
