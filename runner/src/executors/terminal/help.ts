import { createHash } from "node:crypto";

export interface ParsedHelp {
  subcommands: string[];
  flags: string[];
  /** Hash of the structure (subcommands and flags), not of the wording. */
  signature: string;
}

const MAX_SUBCOMMANDS = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER = /^\s*(?:available\s+)?(?:sub)?commands?\s*:?\s*$/i;
const CHOICES = /\{([A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)+)\}/;
const FLAG = /(?:^|[\s,|[(=])(--[A-Za-z0-9][A-Za-z0-9_-]*)/g;

/**
 * Best-effort reader of `--help` output (cobra, click, argparse and similar). It only ever returns names that
 * look like plain words, so nothing parsed here can become a flag, a path or shell syntax when used as an argument.
 */
export function parseHelp(text: string): ParsedHelp {
  const lines = text.replace(/\r/g, "").split("\n");
  const subs: string[] = [];
  const add = (name: string): void => {
    if (NAME.test(name) && name !== "help" && !subs.includes(name) && subs.length < MAX_SUBCOMMANDS) subs.push(name);
  };

  // 1) a "Commands:" style section: entries share the indentation of the first one; deeper lines are wrapped text
  for (let i = 0; i < lines.length; i++) {
    if (!HEADER.test(lines[i] ?? "")) continue;
    let indent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() === "") break;
      const lead = line.length - line.trimStart().length;
      if (lead === 0) break; // next section
      if (indent === -1) indent = lead;
      if (lead !== indent) continue;
      add(line.trim().split(/\s+/)[0]?.replace(/[,:]$/, "") ?? "");
    }
  }

  // 2) argparse-style {a,b,c}
  if (subs.length === 0) {
    for (const line of lines) {
      const m = CHOICES.exec(line);
      if (m?.[1]) for (const name of m[1].split(",")) add(name);
      if (subs.length > 0) break;
    }
  }

  const flags = new Set<string>();
  for (const m of text.matchAll(FLAG)) if (m[1]) flags.add(m[1]);
  const flagList = [...flags].sort();

  const signature = createHash("sha256")
    .update(`cmds:${[...subs].sort().join(",")}|flags:${flagList.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return { subcommands: subs, flags: flagList, signature };
}
