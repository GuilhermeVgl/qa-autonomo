import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/** The CLI under test, already bound to its binary. */
export interface CommandRunner {
  run(args: string[]): Promise<CommandResult>;
}

export type SpawnLike = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RunnerOptions {
  /** "unshare" (default): every command runs in a new user+network namespace, so it has no network at all.
   *  "none": no isolation, only for tests and local development. */
  isolation?: "unshare" | "none";
  timeoutMs?: number;
  maxOutputBytes?: number;
  probe?: () => Promise<boolean>;
  spawnFn?: SpawnLike;
}

const UNSHARE = ["--user", "--map-root-user", "--net", "--"];
const SAFE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"];

/** True when this host lets us create a network namespace without privileges. */
export async function isolationAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn("unshare", [...UNSHARE, "true"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Runs the CLI under test. Safety properties (CLAUDE.md, seção 12): no shell (arguments are passed literally),
 * a scrubbed environment (the runner's tokens never reach the CLI), a throwaway working directory, a time limit,
 * a cap on captured output and, by default, no network. If isolation is required but unavailable it fails closed.
 */
export async function createCommandRunner(binary: string, opts: RunnerOptions = {}): Promise<CommandRunner> {
  const isolation = opts.isolation ?? "unshare";
  if (isolation === "unshare" && !(await (opts.probe ?? isolationAvailable)())) {
    throw new Error("network isolation is not available on this host (user namespaces are required); refusing to run the CLI without it");
  }
  const spawnFn = opts.spawnFn ?? (nodeSpawn as SpawnLike);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxOutput = opts.maxOutputBytes ?? 262_144;

  return {
    async run(args: string[]): Promise<CommandResult> {
      const cwd = await mkdtemp(join(tmpdir(), "qa-cli-"));
      const env: Record<string, string> = {};
      for (const k of SAFE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
      env["HOME"] = cwd;
      const [cmd, argv] = isolation === "unshare" ? ["unshare", [...UNSHARE, binary, ...args]] : [binary, args];
      const started = Date.now();
      try {
        return await new Promise<CommandResult>((resolve) => {
          let child: ChildProcess;
          try {
            child = spawnFn(cmd as string, argv as string[], { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
          } catch (err) {
            resolve({ exitCode: 127, stdout: "", stderr: String(err instanceof Error ? err.message : err), timedOut: false, truncated: false, durationMs: 0 });
            return;
          }
          let stdout = "";
          let stderr = "";
          let truncated = false;
          let timedOut = false;
          const take = (cur: string, chunk: Buffer): string => {
            if (cur.length >= maxOutput) {
              truncated = true;
              return cur;
            }
            const next = cur + chunk.toString("utf8");
            if (next.length > maxOutput) truncated = true;
            return next.slice(0, maxOutput);
          };
          child.stdout?.on("data", (c: Buffer) => (stdout = take(stdout, c)));
          child.stderr?.on("data", (c: Buffer) => (stderr = take(stderr, c)));
          const kill = (): void => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL"); // the whole process group
            } catch {
              child.kill("SIGKILL");
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs);
          child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ exitCode: 127, stdout, stderr: stderr || err.message, timedOut, truncated, durationMs: Date.now() - started });
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ exitCode: code ?? (signal ? 137 : 1), stdout, stderr, timedOut, truncated, durationMs: Date.now() - started });
          });
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
