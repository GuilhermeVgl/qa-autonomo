import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../executors/terminal/exec.js";
import { parseHelp } from "../executors/terminal/help.js";
import type { RunnerEvent } from "../protocol/schemas.js";
import { EventSink } from "./sink.js";
import { exploreTerminal } from "./terminal.js";

const res = (stdout: string, exitCode = 0, stderr = ""): CommandResult => ({ exitCode, stdout, stderr, timedOut: false, truncated: false, durationMs: 1 });

const ROOT = `Usage:\n  samplecli [command]\n\nAvailable Commands:\n  customers  Manage customers\n  orders     Manage orders\n\nFlags:\n  -h, --help  help\n`;
const ORDERS = `Usage:\n  samplecli orders [command]\n\nAvailable Commands:\n  delete  Delete an order\n  list    List orders\n\nFlags:\n  -h, --help  help\n`;
const LEAF = (name: string) => `Usage:\n  samplecli ${name} [flags]\n\nFlags:\n  -h, --help  help\n      --json  output json\n`;

function fakeCli(table: Record<string, CommandResult>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return table[args.join(" ")] ?? res("", 127, "unknown command");
    },
  };
}

const budget = { max_pages: 50, max_depth: 4, max_seconds: 60, max_llm_calls: 0 };

async function run(cli: CommandRunner, over: { policy?: "block" | "allow"; budget?: Partial<typeof budget>; stop?: () => boolean } = {}) {
  const events: RunnerEvent[] = [];
  const sink = new EventSink(async (e) => void events.push(...e));
  const summary = await exploreTerminal({
    binary: "samplecli",
    runner: cli,
    sink,
    policy: over.policy ?? "block",
    budget: { ...budget, ...over.budget },
    shouldStop: over.stop ?? (() => false),
  });
  await sink.flush();
  const nodes = events.flatMap((e) => (e.type === "node_discovered" ? [e.payload] : []));
  const edges = events.flatMap((e) => (e.type === "edge_discovered" ? [e.payload] : []));
  return { summary, nodes, edges };
}

const table = (): Record<string, CommandResult> => ({
  "--help": res(ROOT),
  "customers --help": res(LEAF("customers")),
  "orders --help": res(ORDERS),
  "orders list --help": res(LEAF("orders list")),
  "orders delete --help": res(LEAF("orders delete")),
});

describe("exploreTerminal", () => {
  it("maps the command tree through --help: one command node per command, one edge per subcommand", async () => {
    const cli = fakeCli(table());
    const { nodes, edges, summary } = await run(cli, { policy: "allow" });
    expect(nodes.map((n) => n.label).sort()).toEqual(["samplecli", "samplecli customers", "samplecli orders", "samplecli orders delete", "samplecli orders list"]);
    expect(nodes.every((n) => n.kind === "command" && n.app_role === "cli")).toBe(true);
    expect(nodes.find((n) => n.label === "samplecli orders")?.fingerprint).toBe("samplecli orders");
    expect(edges.map((e) => e.key).sort()).toEqual(["run customers", "run orders", "run orders delete", "run orders list"]);
    expect(summary).toMatchObject({ commands: 5, stopped_by: "exhausted" });
  });

  it("stores how to run the command and the shape of its help, for the regression run", async () => {
    const { nodes } = await run(fakeCli(table()), { policy: "allow" });
    const orders = nodes.find((n) => n.label === "samplecli orders");
    const meta = orders?.metadata as { command: { args: string[]; help_signature: string; subcommands: string[] }; exit_code: number };
    expect(meta.command.args).toEqual(["orders"]);
    expect(meta.command.subcommands).toEqual(["delete", "list"]);
    expect(meta.command.help_signature).toBe(parseHelp(ORDERS).signature);
    expect(meta.exit_code).toBe(0);
  });

  it("never runs destructive-looking subcommands under the block policy, and says so", async () => {
    const cli = fakeCli(table());
    const { nodes, summary } = await run(cli, { policy: "block" });
    expect(cli.calls.some((c) => c.includes("delete"))).toBe(false);
    expect(nodes.some((n) => n.label.endsWith("delete"))).toBe(false);
    expect(summary.skipped_destructive).toBe(1);
  });

  it("only ever runs --help with arguments taken from parsed plain-word names", async () => {
    const cli = fakeCli({ ...table(), "--help": res("Available Commands:\n  orders  ok\n  --rm    flag\n  $(id)   subst\n") });
    await run(cli, { policy: "allow" });
    for (const c of cli.calls) {
      expect(c[c.length - 1]).toBe("--help");
      for (const a of c.slice(0, -1)) expect(a).toMatch(/^[A-Za-z0-9][\w.-]*$/);
    }
  });

  it("records a command whose help crashes as a failing node instead of hiding it", async () => {
    const t = table();
    t["customers --help"] = res("", 1, "panic: nil pointer");
    t["customers -h"] = res("", 1, "panic: nil pointer");
    const { nodes, summary } = await run(fakeCli(t), { policy: "allow" });
    const bad = nodes.find((n) => n.label === "samplecli customers");
    expect((bad?.metadata as { exit_code: number }).exit_code).toBe(1);
    expect(summary.errors).toEqual([{ command: "samplecli customers", exit_code: 1, message: "panic: nil pointer" }]);
  });

  it("falls back to -h when --help is not understood", async () => {
    const t = table();
    t["customers --help"] = res("", 2, "unknown flag --help");
    t["customers -h"] = res(LEAF("customers"));
    const { summary } = await run(fakeCli(t), { policy: "allow" });
    expect(summary.errors).toHaveLength(0);
  });

  it("respects max_depth, max commands and cancellation", async () => {
    const shallow = await run(fakeCli(table()), { policy: "allow", budget: { max_depth: 1 } });
    expect(shallow.nodes.map((n) => n.label).sort()).toEqual(["samplecli", "samplecli customers", "samplecli orders"]);
    const few = await run(fakeCli(table()), { policy: "allow", budget: { max_pages: 2 } });
    expect(few.nodes).toHaveLength(2);
    expect(few.summary.stopped_by).toBe("max_pages");
    let n = 0;
    const stopped = await run(fakeCli(table()), { policy: "allow", stop: () => ++n > 1 });
    expect(stopped.summary.stopped_by).toBe("cancelled");
  });

  it("does not loop on cyclic or repeated command names", async () => {
    const t = table();
    t["orders --help"] = res(ORDERS.replace("delete  Delete an order", "orders  loops back"));
    t["orders orders --help"] = res(ORDERS.replace("delete  Delete an order", "orders  loops back"));
    const { nodes } = await run(fakeCli(t), { policy: "allow", budget: { max_depth: 3 } });
    expect(nodes.length).toBeLessThan(15);
  });
});
