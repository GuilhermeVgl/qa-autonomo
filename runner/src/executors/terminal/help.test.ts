import { describe, expect, it } from "vitest";
import { parseHelp } from "./help.js";

const cobra = `A sample tool

Usage:
  samplecli [command]

Available Commands:
  completion  Generate the autocompletion script
  customers   Manage customers
  help        Help about any command
  orders      Manage orders and
              their lines (wrapped description)

Flags:
  -h, --help      help for samplecli
      --verbose   verbose output

Use "samplecli [command] --help" for more information about a command.
`;

const argparse = `usage: tool [-h] {start,stop,status} ...

positional arguments:
  {start,stop,status}
    start             Start it
    stop              Stop it
    status            Show status

options:
  -h, --help          show this help message and exit
  --config FILE       config file
`;

const click = `Usage: cli [OPTIONS] COMMAND [ARGS]...

Options:
  --version  Show the version and exit.
  --help     Show this message and exit.

Commands:
  deploy  Deploy the thing
  init    Initialize
`;

const leaf = `Usage: samplecli orders list [flags]

Flags:
  -h, --help          help for list
      --status string filter by status
`;

describe("parseHelp", () => {
  it("reads cobra-style Available Commands, ignoring wrapped descriptions and help", () => {
    const h = parseHelp(cobra);
    expect(h.subcommands).toEqual(["completion", "customers", "orders"]);
    expect(h.flags).toEqual(["--help", "--verbose"]);
  });

  it("reads argparse choices", () => {
    const h = parseHelp(argparse);
    expect(h.subcommands).toEqual(["start", "stop", "status"]);
    expect(h.flags).toEqual(["--config", "--help"]);
  });

  it("reads click-style Commands", () => {
    expect(parseHelp(click).subcommands).toEqual(["deploy", "init"]);
  });

  it("finds no subcommands in a leaf command but still sees its flags", () => {
    const h = parseHelp(leaf);
    expect(h.subcommands).toEqual([]);
    expect(h.flags).toEqual(["--help", "--status"]);
  });

  it("gives a stable signature that changes when subcommands or flags change", () => {
    const a = parseHelp(cobra).signature;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(parseHelp(cobra).signature).toBe(a);
    expect(parseHelp(cobra.replace("customers   Manage customers\n", "")).signature).not.toBe(a);
    expect(parseHelp(cobra.replace("--verbose", "--debug")).signature).not.toBe(a);
    // wording and spacing do not matter, structure does
    expect(parseHelp(cobra.replace("Manage orders and", "Orders stuff and")).signature).toBe(a);
  });

  it("never returns names that could be abused as arguments", () => {
    const evil = "Commands:\n  ok        fine\n  --rm      a flag, not a command\n  $(id)     substitution\n  a;b       shell\n  " + "x".repeat(100) + "   too long\n";
    expect(parseHelp(evil).subcommands).toEqual(["ok"]);
  });

  it("copes with empty or hostile output", () => {
    expect(parseHelp("").subcommands).toEqual([]);
    expect(parseHelp("\u0000\u0001 binary garbage").subcommands).toEqual([]);
    expect(parseHelp("Commands:\n" + "  c1  d\n".repeat(5000)).subcommands.length).toBeLessThanOrEqual(200);
  });
});
