import { describe, expect, it } from "vitest";
import { base32Decode, totpCode } from "./totp.js";

// RFC 6238 Appendix B test vectors (SHA-1, seed "12345678901234567890" = base32 below), truncated to 6 digits.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors", () => {
    expect(totpCode(SECRET, 59_000)).toBe("287082");
    expect(totpCode(SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(SECRET, 1_234_567_890_000)).toBe("005924");
    expect(totpCode(SECRET, 2_000_000_000_000)).toBe("279037");
  });

  it("is case-insensitive and ignores spaces and padding", () => {
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000)).toBe("287082");
  });

  it("rejects an invalid base32 secret", () => {
    expect(() => base32Decode("not-base32!")).toThrow();
  });
});
