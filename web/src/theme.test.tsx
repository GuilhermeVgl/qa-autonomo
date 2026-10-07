import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, loadThemePref, resolveTheme, useTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveTheme", () => {
  it("follows the system only in auto mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("loadThemePref", () => {
  it("defaults to auto and ignores garbage", () => {
    expect(loadThemePref()).toBe("system");
    localStorage.setItem("qa_theme", "neon");
    expect(loadThemePref()).toBe("system");
    localStorage.setItem("qa_theme", "dark");
    expect(loadThemePref()).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("marks the document with the resolved theme", () => {
    applyTheme("light", true);
    expect(document.documentElement.dataset["theme"]).toBe("light");
    applyTheme("system", true);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});

describe("useTheme", () => {
  it("remembers the choice and applies it right away", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const { result } = renderHook(() => useTheme());
    expect(result.current.pref).toBe("system");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    act(() => result.current.setPref("dark"));
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("qa_theme")).toBe("dark");
  });

  it("follows the system when the OS theme changes in auto mode", () => {
    let listener: (() => void) | undefined;
    const mq = { matches: false, addEventListener: (_: string, l: () => void) => (listener = l), removeEventListener: () => undefined };
    vi.stubGlobal("matchMedia", () => mq);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe("light");
    mq.matches = true;
    act(() => listener?.());
    expect(result.current.resolved).toBe("dark");
  });
});
