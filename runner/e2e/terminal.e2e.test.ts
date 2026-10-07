import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventSink } from "../src/agent/sink.js";
import { runRegression } from "../src/agent/regression.js";
import { exploreTerminal } from "../src/agent/terminal.js";
import { createCommandRunner, isolationAvailable } from "../src/executors/terminal/exec.js";
import type { RunnerEvent } from "../src/protocol/schemas.js";

const binary = fileURLToPath(new URL("../../fixtures/sample-cli/samplecli", import.meta.url));
const marker = fileURLToPath(new URL("../../fixtures/sample-cli/v2", import.meta.url));
const budget = { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 };

// Real network isolation whenever the host allows it (CI Linux); otherwise run unisolated so the test still works locally.
const isolation = (await isolationAvailable()) ? ("unshare" as const) : ("none" as const);

async function explore(policy: "block" | "allow") {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const runner = await createCommandRunner(binary, { isolation });
  const summary = await exploreTerminal({ binary: "samplecli", runner, sink, policy, budget, shouldStop: () => false });
  await sink.flush();
  return { summary, events, runner };
}

const nodesOf = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === "node_discovered" ? [e.payload] : []));

describe("terminal executor against fixtures/sample-cli", () => {
  it("maps the command tree, records the crashing command and never runs the destructive one", async () => {
    const log = await mkdtemp(join(tmpdir(), "samplecli-log-"));
    try {
      const { summary, events } = await explore("block");
      const labels = nodesOf(events).map((n) => n.label).sort();
      expect(labels).toEqual(["samplecli", "samplecli customers", "samplecli orders", "samplecli orders list", "samplecli orders show", "samplecli reports"]);
      // B6: customers --help crashes; it is a node with exit_code 1 and shows up in the summary
      expect(summary.errors.map((e) => e.command)).toEqual(["samplecli customers"]);
      expect(summary.errors[0]?.message).toContain("panic");
      // T6: orders delete is destructive-looking, so it was not even asked for --help
      expect(summary.skipped_destructive).toBe(1);
      expect(labels).not.toContain("samplecli orders delete");
    } finally {
      await rm(log, { recursive: true, force: true });
    }
  }, 60_000);

  it("regression: healthy commands pass, the crash fails, a changed help structure fails, each with stdout evidence", async () => {
    const { events, runner } = await explore("block");
    const targets = nodesOf(events).map((n, i) => {
      const cmd = (n.metadata as { command: { args: string[]; help_signature: string } }).command;
      return {
        kind: "command" as const,
        node_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
        fingerprint: n.fingerprint,
        label: n.label,
        app_role: "cli",
        requirement_keys: ["REQ-CLI"],
        args: cmd.args,
        help_signature: cmd.help_signature,
      };
    });
    const env = { base_url: "terminal://samplecli", allowed_hosts: [], destructive_policy: "block" as const };
    const uploads: string[] = [];
    const uploader = { upload: async (kind: string, contentType: string) => (uploads.push(kind), { kind: "stdout" as const, content_type: contentType, storage_key: `o/r/${uploads.length}.txt` }) };

    async function go() {
      const out: RunnerEvent[] = [];
      const sink = new EventSink(async (e) => void out.push(...e));
      const summary = await runRegression({ driver: { newSession: async () => null }, sink, environment: env, credentials: [], targets, uploader, budget, shouldStop: () => false, command: runner });
      await sink.flush();
      const verdict = new Map<string, { result: string; actual: string }>();
      for (const e of out) if (e.type === "step_finished") verdict.set(targets.find((t) => t.node_id === e.payload.key)?.label ?? "?", { result: e.payload.result, actual: e.payload.actual });
      return { summary, verdict };
    }

    const first = await go();
    expect(first.verdict.get("samplecli orders")?.result).toBe("pass");
    expect(first.verdict.get("samplecli orders list")?.result).toBe("pass");
    expect(first.verdict.get("samplecli customers")).toMatchObject({ result: "fail" });
    expect(first.verdict.get("samplecli customers")?.actual).toContain("exit code 1");
    expect(first.summary).toMatchObject({ failed: 1, passed: targets.length - 1 });
    expect(uploads.length).toBe(targets.length);

    // the CLI ships a new version that adds a subcommand: the structure of `orders` --help changed
    await writeFile(marker, "");
    try {
      const second = await go();
      expect(second.verdict.get("samplecli orders")?.result).toBe("fail");
      expect(second.verdict.get("samplecli orders")?.actual).toMatch(/structure changed/);
      expect(second.verdict.get("samplecli orders list")?.result).toBe("pass");
    } finally {
      await rm(marker, { force: true });
    }
  }, 60_000);

  it("with destructive actions allowed it explores `orders delete --help`, which only prints help and deletes nothing", async () => {
    const { events } = await explore("allow");
    expect(nodesOf(events).map((n) => n.label)).toContain("samplecli orders delete");
    // reading the marker proves the fixture is intact and the test left no v2 behind
    await expect(readFile(marker)).rejects.toThrow();
  }, 60_000);
});
