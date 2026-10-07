import { describe, expect, it } from "vitest";
import { toneOf } from "./tone";

describe("toneOf", () => {
  it("shows what the last test said, whatever the coverage", () => {
    expect(toneOf(false, "pass", "no_spec")).toBe("passed");
    expect(toneOf(false, "fail", "covered")).toBe("failing");
    expect(toneOf(false, "error", "covered")).toBe("failing");
    expect(toneOf(false, "skipped", "covered")).toBe("skipped");
  });

  it("a screen that failed when it was explored stays failing, even if a later check passed nothing", () => {
    expect(toneOf(true, undefined, "covered")).toBe("failing");
    expect(toneOf(true, "pass", "covered")).toBe("failing");
  });

  it("without a test it falls back to coverage, and to neutral when nothing is known", () => {
    expect(toneOf(false, undefined, "covered")).toBe("covered");
    expect(toneOf(false, undefined, "pending")).toBe("pending");
    expect(toneOf(false, undefined, "no_spec")).toBe("no_spec");
    expect(toneOf(false, undefined, undefined)).toBe("neutral");
  });
});
