import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "qa_theme";

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme => (pref === "system" ? (systemDark ? "dark" : "light") : pref);

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function savePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage unavailable: the choice lasts until the page is closed
  }
}

/** The CSS reads `data-theme`; `index.html` sets it before the first paint so there is no flash. */
export function applyTheme(pref: ThemePref, systemDark: boolean): Theme {
  const theme = resolveTheme(pref, systemDark);
  document.documentElement.dataset["theme"] = theme;
  return theme;
}

const systemQuery = () => (typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null);

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(loadThemePref);
  const [systemDark, setSystemDark] = useState(() => systemQuery()?.matches ?? false);

  useEffect(() => {
    const mq = systemQuery();
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(pref, systemDark);
  useEffect(() => void applyTheme(pref, systemDark), [pref, systemDark]);

  const setPref = useCallback((next: ThemePref) => {
    savePref(next);
    setPrefState(next);
  }, []);
  return { pref, resolved, setPref };
}

type ThemeState = ReturnType<typeof useTheme>;
const ThemeContext = createContext<ThemeState | null>(null);

/** One theme state for the whole app, so the sidebar switch and the settings screen always agree. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: useTheme() }, children);
}

/** The app's theme; falls back to a standalone state when rendered without a provider (tests). */
export function useAppTheme(): ThemeState {
  const shared = useContext(ThemeContext);
  const local = useTheme();
  return shared ?? local;
}
