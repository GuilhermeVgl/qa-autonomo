import type { Run } from "./api";

/** What kept a run from doing its job, as the runner wrote it in the summary: one problem, not a bug per screen. */
export interface Blocked {
  kind: "app_down" | "login_failed";
  message: string;
  roles?: string[];
  details?: { role: string; reason: string; message: string }[];
}

/** What the run said stopped it, if anything. */
export function blockedOf(run: Partial<Pick<Run, "summary">> | undefined): Blocked | undefined {
  const b = (run?.summary as { blocked?: Partial<Blocked> } | undefined)?.blocked;
  return b && b.message && (b.kind === "app_down" || b.kind === "login_failed") ? (b as Blocked) : undefined;
}

/**
 * What is wrong with the environment right now: what stopped the latest run that finished. A later run that worked clears it,
 * which is why it is shown until then, on every page, and not only on the run.
 */
export function currentBlock(runs: Run[] | undefined): { run: Run; blocked: Blocked } | undefined {
  const last = runs?.find((r) => r.status === "succeeded" || r.status === "failed"); // newest first
  const blocked = blockedOf(last);
  return last && blocked ? { run: last, blocked } : undefined;
}
