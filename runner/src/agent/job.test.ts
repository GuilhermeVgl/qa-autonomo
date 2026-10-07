import { describe, expect, it } from "vitest";
import type { Job, RunnerEvent } from "../protocol/schemas.js";
import type { Driver, Session } from "./explorer.js";
import { runJob, type JobClient } from "./job.js";

const job: Job = {
  run_id: "0198c1f0-0000-7000-8000-000000000001",
  attempt: 1,
  graph_id: "0198c1f0-0000-7000-8000-000000000002",
  type: "exploration",
  budget: { max_pages: 10, max_depth: 3, max_seconds: 30, max_llm_calls: 0 },
  environment: { base_url: "https://app.test/", allowed_hosts: ["app.test"], destructive_policy: "block" },
  credentials: [],
};

class FakeClient implements JobClient {
  events: RunnerEvent[] = [];
  completed: { status: string; summary: Record<string, unknown> }[] = [];
  heartbeats = 0;
  cancelAfterHeartbeats = Infinity;
  async heartbeat() {
    this.heartbeats++;
    return { cancel: this.heartbeats >= this.cancelAfterHeartbeats };
  }
  async sendEvents(_id: string, e: RunnerEvent[]) {
    this.events.push(...e);
  }
  async complete(_id: string, status: "succeeded" | "failed", summary: Record<string, unknown>) {
    this.completed.push({ status, summary });
  }
}

const oneNodeDriver = (delayMs = 0): Driver => ({
  newSession: async (): Promise<Session> => ({
    screenshot: async () => new Uint8Array([1]),
    visit: async (url) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { url, status: 200, domSignature: "x", links: [{ href: "https://app.test/more", label: "more" }] };
    },
    close: async () => {},
  }),
});

describe("runJob", () => {
  it("explores, uploads events and completes as succeeded with the summary", async () => {
    const client = new FakeClient();
    await runJob({ client, job, driver: oneNodeDriver(), heartbeatMs: 1000 });
    expect(client.events.length).toBeGreaterThan(0);
    expect(client.completed).toHaveLength(1);
    expect(client.completed[0]?.status).toBe("succeeded");
    expect(client.completed[0]?.summary).toMatchObject({ pages: 2, stopped_by: "exhausted" });
  });

  it("hands a continued exploration the screens it already knows, so they are not announced again", async () => {
    const { nodeFingerprint } = await import("../fingerprint/fingerprint.js");
    const home = nodeFingerprint({ url: "https://app.test/", domSignature: "x", appRole: "anonymous" });
    const client = new FakeClient();
    await runJob({ client, job: { ...job, resume: { generation: 1, known: [{ fingerprint: home, app_role: "anonymous" }] } }, driver: oneNodeDriver(), heartbeatMs: 1000 });
    const announced = client.events.flatMap((e) => (e.type === "node_discovered" ? [e.payload.fingerprint] : []));
    expect(announced).not.toContain(home);
    expect(client.completed[0]?.summary).toMatchObject({ resumed: { known_pages: 1 } });
  });

  it("sends events while the exploration is still running, not only at the end", async () => {
    const client = new FakeClient();
    let sawEventsMidRun = false;
    const driver: Driver = {
      newSession: async (): Promise<Session> => ({
        screenshot: async () => new Uint8Array([1]),
        visit: async (url) => {
          // the second page is slower than the flush interval: the first page's events must already be on the server
          if (url.endsWith("/more")) {
            await new Promise((r) => setTimeout(r, 120));
            sawEventsMidRun = client.events.length > 0 && client.completed.length === 0;
          }
          return { url, status: 200, domSignature: "x", links: [{ href: "https://app.test/more", label: "more" }] };
        },
        close: async () => {},
      }),
    };
    await runJob({ client, job, driver, heartbeatMs: 1000, flushMs: 20 });
    expect(sawEventsMidRun).toBe(true);
  });

  it("includes extra summary fields from the executor (e.g. blocked requests)", async () => {
    const client = new FakeClient();
    await runJob({ client, job, driver: oneNodeDriver(), heartbeatMs: 1000, extraSummary: () => ({ blocked_requests: ["http://x"] }) });
    expect(client.completed[0]?.summary).toMatchObject({ blocked_requests: ["http://x"] });
  });

  it("completes as failed when the exploration throws", async () => {
    const client = new FakeClient();
    const driver: Driver = { newSession: async () => Promise.reject(new Error("browser crashed")) };
    await runJob({ client, job, driver, heartbeatMs: 1000 });
    expect(client.completed[0]).toMatchObject({ status: "failed", summary: { error: "browser crashed" } });
  });

  it("stops without completing when the control plane asks to cancel", async () => {
    const client = new FakeClient();
    client.cancelAfterHeartbeats = 1;
    await runJob({ client, job, driver: oneNodeDriver(60), heartbeatMs: 10 });
    expect(client.heartbeats).toBeGreaterThanOrEqual(1);
    expect(client.completed).toHaveLength(0); // already cancelled server-side; completing would be a 409
  });

  it("stops heartbeating once the job is over", async () => {
    const client = new FakeClient();
    await runJob({ client, job, driver: oneNodeDriver(), heartbeatMs: 5 });
    const after = client.heartbeats;
    await new Promise((r) => setTimeout(r, 40));
    expect(client.heartbeats).toBe(after);
  });

  it("runs regression jobs: steps with evidence, completed as succeeded even when steps fail", async () => {
    const client = new FakeClient();
    const regJob: Job = {
      ...job,
      type: "regression",
      targets: [{ node_id: "00000000-0000-0000-0000-000000000009", fingerprint: "fp-expected", url: "https://app.test/orders", label: "/orders", app_role: "anonymous", requirement_keys: ["REQ-001"] }],
    };
    const uploads: string[] = [];
    await runJob({
      client,
      job: regJob,
      driver: oneNodeDriver(),
      uploader: {
        upload: async (kind, contentType) => {
          uploads.push(kind);
          return { kind: "screenshot", content_type: contentType, storage_key: "org/run/1.png" };
        },
      },
      heartbeatMs: 1000,
    });
    expect(client.events.map((e) => e.type)).toEqual(["step_started", "step_finished"]);
    expect(client.completed[0]?.status).toBe("succeeded");
    // fingerprint differs from the recorded one, so the step fails, but the run itself completed
    expect(client.completed[0]?.summary).toMatchObject({ steps: 1, failed: 1 });
  });

  it("explores a terminal environment through the command runner, without any browser", async () => {
    const client = new FakeClient();
    const tJob: Job = { ...job, environment: { ...job.environment, kind: "terminal", terminal: { binary: "samplecli" }, base_url: "terminal://samplecli", allowed_hosts: [] } };
    const calls: string[][] = [];
    await runJob({
      client,
      job: tJob,
      driver: { newSession: () => Promise.reject(new Error("a terminal job must not open a browser")) },
      command: {
        run: async (args) => {
          calls.push(args);
          return { exitCode: 0, stdout: "Usage: samplecli\n", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
        },
      },
      heartbeatMs: 1000,
    });
    expect(calls).toEqual([["--help"]]);
    expect(client.events.map((e) => e.type)).toEqual(["node_discovered"]);
    expect(client.completed[0]).toMatchObject({ status: "succeeded", summary: { commands: 1 } });
  });

  it("fails a terminal job that has no command runner instead of silently using a browser", async () => {
    const client = new FakeClient();
    const tJob: Job = { ...job, environment: { ...job.environment, kind: "terminal", terminal: { binary: "x" } } };
    await runJob({ client, job: tJob, driver: oneNodeDriver(), heartbeatMs: 1000 });
    expect(client.completed[0]).toMatchObject({ status: "failed" });
  });
});
