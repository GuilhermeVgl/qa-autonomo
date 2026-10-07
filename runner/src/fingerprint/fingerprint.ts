import { createHash } from "node:crypto";
import { routePattern } from "./route.js";

export interface FingerprintInput {
  url: string;
  domSignature: string;
  appRole: string;
}

/** Fingerprint of a page/modal node (CLAUDE.md, seção 9): route pattern + DOM structure + role. */
export function nodeFingerprint(input: FingerprintInput): string {
  const domHash = createHash("sha256").update(input.domSignature).digest("hex");
  return createHash("sha256")
    .update(`${routePattern(input.url)}|${domHash}|${input.appRole}`)
    .digest("hex")
    .slice(0, 32);
}
