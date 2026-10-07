import { createHash } from "node:crypto";
import type { CommandResult, CommandRunner } from "../executors/terminal/exec.js";
import { parseHelp, type ParsedHelp } from "../executors/terminal/help.js";
import type { Job } from "../protocol/schemas.js";
import { shouldSkip, type DestructivePolicy } from "./guards.js";
import type { EventSink } from "./sink.js";

export interface TerminalExploreInput {
  binary: string;
  runner: CommandRunner;
  sink: EventSink;
  policy: DestructivePolicy;
  budget: Job["budget"];
  shouldStop: () => boolean;
}

export interface TerminalSummary {
  commands: number;
  skipped_destructive: number;
  errors: { command: string; exit_code: number; message: string }[];
  stopped_by: "exhausted" | "max_pages" | "max_seconds" | "cancelled";
}

/** Normalized command (CLAUDE.md, seção 9): the binary plus the subcommand path, never flags or values. */
export function commandLabel(binary: string, path: string[]): string {
  return [binary, ...path].join(" ");
}

/** Runs `<path> --help` (falling back to `-h`). Only ever called with parsed plain-word names. */
export async function helpOf(runner: CommandRunner, path: string[]): Promise<{ result: CommandResult; help: ParsedHelp }> {
  let result = await runner.run([...path, "--help"]);
  if (result.exitCode !== 0) {
    const retry = await runner.run([...path, "-h"]);
    if (retry.exitCode === 0) result = retry;
  }
  // many CLIs print help on stderr
  return { result, help: parseHelp(result.stdout || result.stderr) };
}

/**
 * Breadth-first map of a CLI through its own --help output. Subcommands whose name looks destructive are not run
 * under the block/confirm policy; everything else is only ever invoked with `--help`.
 */
export async function exploreTerminal(input: TerminalExploreInput): Promise<TerminalSummary> {
  const { binary, runner, sink, budget } = input;
  const summary: TerminalSummary = { commands: 0, skipped_destructive: 0, errors: [], stopped_by: "exhausted" };
  const deadline = Date.now() + budget.max_seconds * 1000;
  const seen = new Set<string>();
  const queue: { path: string[]; parent: string | null }[] = [{ path: [], parent: null }];

  while (queue.length > 0) {
    if (input.shouldStop()) return { ...summary, stopped_by: "cancelled" };
    if (Date.now() >= deadline) return { ...summary, stopped_by: "max_seconds" };
    if (summary.commands >= budget.max_pages) return { ...summary, stopped_by: "max_pages" };

    const { path, parent } = queue.shift() as { path: string[]; parent: string | null };
    const label = commandLabel(binary, path);
    if (seen.has(label)) continue;
    seen.add(label);

    const { result, help } = await helpOf(runner, path);
    summary.commands++;
    if (result.exitCode !== 0) summary.errors.push({ command: label, exit_code: result.exitCode, message: firstLine(result.stderr || result.stdout) });

    sink.node({
      fingerprint: label,
      kind: "command",
      label,
      app_role: "cli",
      metadata: { command: { args: path, help_signature: help.signature, subcommands: help.subcommands }, exit_code: result.exitCode },
    });
    if (parent !== null) {
      sink.edge({
        key: `run ${path.join(" ")}`,
        from_fingerprint: parent,
        to_fingerprint: label,
        action: { type: "run", args: [...path, "--help"] },
        app_role: "cli",
      });
    }

    if (path.length >= budget.max_depth) continue;
    for (const sub of help.subcommands) {
      if (shouldSkip({ label: sub, href: sub }, input.policy)) {
        summary.skipped_destructive++;
        continue;
      }
      queue.push({ path: [...path, sub], parent: label });
    }
  }
  return summary;
}

export function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 300);
}

/** Short stable id of a help text, handy in step results. */
export function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}
