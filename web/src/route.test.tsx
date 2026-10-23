import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { parseHash, useRoute } from "./route";

beforeEach(() => {
  window.location.hash = "";
});

describe("parseHash", () => {
  it("maps addresses to pages, with product as the default when there is no hash", () => {
    expect(parseHash("")).toEqual({ page: "product", sub: undefined });
    expect(parseHash("#")).toEqual({ page: "product", sub: undefined });
    expect(parseHash("#/")).toEqual({ page: "overview", sub: undefined });
    expect(parseHash("#/mapa")).toEqual({ page: "map", sub: undefined });
    expect(parseHash("#/produto")).toEqual({ page: "product", sub: undefined });
    expect(parseHash("#/specs")).toEqual({ page: "specs", sub: undefined });
    expect(parseHash("#/bugs")).toEqual({ page: "bugs", sub: undefined });
    expect(parseHash("#/execucoes")).toEqual({ page: "runs", sub: undefined });
    expect(parseHash("#/config/tokens")).toEqual({ page: "settings", sub: "tokens" });
  });

  it("knows the flows page", () => {
    expect(parseHash("#/fluxos")).toEqual({ page: "flows", sub: undefined });
  });

  it("falls back to the overview for unknown addresses", () => {
    expect(parseHash("#/nada/aqui").page).toBe("overview");
  });
});

describe("useRoute", () => {
  it("follows the address bar and navigates with go()", async () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current.page).toBe("product");
    act(() => result.current.go("map"));
    expect(window.location.hash).toBe("#/mapa");
    expect(result.current.page).toBe("map");
    act(() => result.current.go("settings", "ambientes"));
    expect(window.location.hash).toBe("#/config/ambientes");
    expect(result.current.sub).toBe("ambientes");
    act(() => {
      window.location.hash = "#/bugs";
    });
    await waitFor(() => expect(result.current.page).toBe("bugs")); // the browser reports hash changes asynchronously
  });
});
