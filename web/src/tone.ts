export type NodeCoverage = "covered" | "pending" | "no_spec";
/** What the last test said about a screen. */
export type NodeResult = "pass" | "fail" | "error" | "skipped";
export type Tone = NodeCoverage | "failing" | "passed" | "skipped" | "neutral";

/** Test results come first (they are what the person wants to see after a run), then coverage, then nothing known. */
export function toneOf(failingWhenExplored: boolean, result: NodeResult | undefined, coverage: NodeCoverage | undefined): Tone {
  if (failingWhenExplored || result === "fail" || result === "error") return "failing";
  if (result === "pass") return "passed";
  if (result === "skipped") return "skipped";
  return coverage ?? "neutral";
}

/** How a tone reads in words (legends, tooltips, accessible names). */
export const TONE_LABEL: Record<Tone, string> = {
  passed: "passou",
  failing: "falhou",
  skipped: "pulado",
  covered: "coberto, não testado",
  pending: "pendência",
  no_spec: "sem spec",
  neutral: "alcançado",
};
