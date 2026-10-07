import type { Run } from "./api";
import { blockedOf } from "./blocked";

/**
 * The exploration a person can continue: the most recent one, if it stopped before the end (cancelled, failed, or out of
 * pages or time). Mirrors the server's rule, which has the last word.
 */
export function resumableExploration(runs: Run[] | undefined): Run | undefined {
  const last = runs?.find((r) => r.type === "exploration"); // newest first
  if (!last) return undefined;
  if (blockedOf(last)) return undefined; // it never got to map anything: the fix is the login or the application, then a new exploration
  if (last.status === "cancelled" || last.status === "failed") return last;
  if (last.status === "succeeded") {
    const stoppedBy = (last.summary as { stopped_by?: string }).stopped_by;
    if (stoppedBy === "max_pages" || stoppedBy === "max_seconds" || stoppedBy === "cancelled") return last;
  }
  return undefined;
}

/** Why an exploration stopped, in a few words. */
export function stoppedBecause(run: Run): string {
  if (run.status === "cancelled") return "foi cancelada";
  if (run.status === "failed") return "falhou";
  const stoppedBy = (run.summary as { stopped_by?: string }).stopped_by;
  if (stoppedBy === "max_pages") return "atingiu o limite de telas";
  if (stoppedBy === "max_seconds") return "atingiu o limite de tempo";
  return "parou antes do fim";
}
