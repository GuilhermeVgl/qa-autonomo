import { describe, expect, it } from "vitest";
import { CAPTURE_VIEWPORT, mouseButton, specialKey, toViewport } from "./input.js";

describe("capture input mapping", () => {
  it("maps normalized points into the viewport, clamped to its bounds", () => {
    expect(toViewport({ type: "click", x: 0.5, y: 0.5 })).toEqual({ x: 640, y: 400 });
    expect(toViewport({ type: "click", x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(toViewport({ type: "click", x: 1, y: 1 })).toEqual({ x: CAPTURE_VIEWPORT.width, y: CAPTURE_VIEWPORT.height });
    expect(toViewport({ type: "click", x: 2, y: -1 })).toEqual({ x: CAPTURE_VIEWPORT.width, y: 0 });
  });

  it("maps mouse buttons, defaulting to left", () => {
    expect(mouseButton("right")).toBe("right");
    expect(mouseButton("middle")).toBe("middle");
    expect(mouseButton(undefined)).toBe("left");
    expect(mouseButton("whatever")).toBe("left");
  });

  it("forwards only known special keys (printable chars go as text)", () => {
    expect(specialKey("Enter")).toBe("Enter");
    expect(specialKey("Backspace")).toBe("Backspace");
    expect(specialKey("a")).toBeNull();
    expect(specialKey(undefined)).toBeNull();
  });
});
