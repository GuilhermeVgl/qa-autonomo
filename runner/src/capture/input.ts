import type { CaptureInput } from "../protocol/schemas.js";

/** The fixed viewport the capture browser renders at; the UI maps its clicks into this space (normalized 0..1). */
export const CAPTURE_VIEWPORT = { width: 1280, height: 800 };

/** Maps a normalized (0..1) point to pixel coordinates in the capture viewport, clamped to its bounds. */
export function toViewport(e: CaptureInput, vw = CAPTURE_VIEWPORT.width, vh = CAPTURE_VIEWPORT.height): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * max)));
  return { x: clamp(e.x ?? 0, vw), y: clamp(e.y ?? 0, vh) };
}

/** Playwright mouse button name for what the UI reported. */
export function mouseButton(b: string | undefined): "left" | "right" | "middle" {
  return b === "right" ? "right" : b === "middle" ? "middle" : "left";
}

/** Special keys the capture forwards by name; printable characters come as `text` events instead. */
const SPECIAL = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** The Playwright key name for a UI key event, or null if it is not a key we forward. */
export function specialKey(key: string | undefined): string | null {
  return key && SPECIAL.has(key) ? key : null;
}
