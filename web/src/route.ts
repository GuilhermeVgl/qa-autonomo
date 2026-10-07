import { useCallback, useEffect, useState } from "react";

export type Page = "overview" | "map" | "flows" | "specs" | "bugs" | "runs" | "settings";

const PATHS: Record<Page, string> = { overview: "", map: "mapa", flows: "fluxos", specs: "specs", bugs: "bugs", runs: "execucoes", settings: "config" };
const BY_PATH = Object.fromEntries(Object.entries(PATHS).map(([page, path]) => [path, page as Page])) as Record<string, Page>;

export interface Route {
  page: Page;
  sub: string | undefined;
}

export function parseHash(hash: string): Route {
  const [first = "", sub] = hash.replace(/^#\/?/, "").split("/");
  return { page: BY_PATH[first] ?? "overview", sub: sub || undefined };
}

/** Pages live in the address bar's hash, so every screen has a link of its own and the back button works. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = useCallback((page: Page, sub?: string) => {
    window.location.hash = `#/${PATHS[page]}${sub ? `/${sub}` : ""}`;
    setRoute({ page, sub });
  }, []);
  return { ...route, go };
}
