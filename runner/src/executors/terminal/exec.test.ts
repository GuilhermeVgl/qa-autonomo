import { describe, expect, it } from "vitest";
import { createCommandRunner, isolationAvailable, type SpawnLike } from "./exec.js";

const node = process.execPath;
const canIsolate = await isolationAvailable();

describe("createCommandRunner (isolation none, for tests)", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await createCommandRunner(node, { isolation: "none" });
    const out = await r.run(["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
    expect(out).toMatchObject({ exitCode: 3, timedOut: false, truncated: false });
    expect(out.stdout.trim()).toBe("out");
    expect(out.stderr.trim()).toBe("err");
  });

  it("passes arguments literally: there is no shell", async () => {
    const r = await createCommandRunner(node, { isolation: "none" });
    const out = await r.run(["-e", "console.log(process.argv.slice(1).join('|'))", "a;b", "$(id)", "`x`", "&&", "| cat"]);
    expect(out.stdout.trim()).toBe("a;b|$(id)|`x`|&&|| cat");
  });

  it("does not leak the runner's environment (tokens, credentials) to the CLI under test", async () => {
    process.env["RUNNER_TOKEN"] = "super-secret";
    process.env["LLM_API_KEY"] = "also-secret";
    try {
      const r = await createCommandRunner(node, { isolation: "none" });
      const out = await r.run(["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"]);
      const keys = JSON.parse(out.stdout) as string[];
      expect(keys).not.toContain("RUNNER_TOKEN");
      expect(keys).not.toContain("LLM_API_KEY");
      expect(keys).toContain("PATH");
    } finally {
      delete process.env["RUNNER_TOKEN"];
      delete process.env["LLM_API_KEY"];
    }
  });

  it("runs in a throwaway directory, not in the runner's working directory", async () => {
    const r = await createCommandRunner(node, { isolation: "none" });
    const out = await r.run(["-e", "console.log(process.cwd())"]);
    expect(out.stdout.trim()).not.toBe(process.cwd());
    expect(out.stdout.trim()).toMatch(/qa-cli-/);
  });

  it("kills commands that run too long", async () => {
    const r = await createCommandRunner(node, { isolation: "none", timeoutMs: 200 });
    const out = await r.run(["-e", "setInterval(() => {}, 1000)"]);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0);
  });

  it("caps captured output", async () => {
    const r = await createCommandRunner(node, { isolation: "none", maxOutputBytes: 1000 });
    const out = await r.run(["-e", "process.stdout.write('x'.repeat(500000))"]);
    expect(out.stdout.length).toBeLessThanOrEqual(1000);
    expect(out.truncated).toBe(true);
  });

  it("reports a missing binary as an error result, not an exception", async () => {
    const r = await createCommandRunner("/definitely/not/here", { isolation: "none" });
    const out = await r.run(["--help"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toMatch(/ENOENT|not found|spawn/i);
  });
});

describe("network isolation", () => {
  it("wraps every command in a new network namespace and fails closed when that is not available", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const fake: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      throw new Error("spawn is not expected to run in this test");
    };
    await expect(createCommandRunner("samplecli", { isolation: "unshare", probe: async () => false, spawnFn: fake })).rejects.toThrow(/network isolation/i);

    const ok = await createCommandRunner("samplecli", { isolation: "unshare", probe: async () => true, spawnFn: fake });
    await ok.run(["orders", "--help"]).catch(() => undefined);
    expect(calls[0]?.cmd).toBe("unshare");
    expect(calls[0]?.args).toEqual(["--user", "--map-root-user", "--net", "--", "samplecli", "orders", "--help"]);
  });

  it.runIf(canIsolate)("really removes the network from the child (loopback included)", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer((s) => s.end("hi"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await createCommandRunner(node, { isolation: "unshare" });
      const out = await r.run([
        "-e",
        `require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('CONNECTED'); process.exit(0); }).on('error', () => { console.log('NO-NETWORK'); process.exit(0); })`,
      ]);
      expect(out.stdout.trim()).toBe("NO-NETWORK");
    } finally {
      srv.close();
    }
  });
});
