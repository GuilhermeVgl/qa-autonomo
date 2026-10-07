import { describe, expect, it } from "vitest";
import { nodeFingerprint } from "./fingerprint.js";

describe("nodeFingerprint", () => {
  const base = { url: "https://a.com/orders/1", domSignature: "main(table)", appRole: "admin" };

  it("same route pattern, structure and role -> same fingerprint (data differs)", () => {
    expect(nodeFingerprint(base)).toBe(nodeFingerprint({ ...base, url: "https://a.com/orders/999?tab=x" }));
  });

  it("changes with structure, route and role", () => {
    const fp = nodeFingerprint(base);
    expect(nodeFingerprint({ ...base, domSignature: "main(ul)" })).not.toBe(fp);
    expect(nodeFingerprint({ ...base, url: "https://a.com/customers/1" })).not.toBe(fp);
    expect(nodeFingerprint({ ...base, appRole: "operator" })).not.toBe(fp);
  });

  it("is a stable hex digest", () => {
    expect(nodeFingerprint(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});
