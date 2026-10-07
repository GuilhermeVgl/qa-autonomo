import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "./api";
import type { Box } from "./flows";
import { ScreenCard } from "./ScreenCard";

const node = (over: Partial<GraphNode> = {}): GraphNode => ({ id: "n1", kind: "page", label: "/clients", app_roles: ["admin"], metadata: {}, ...over });
const box = (over: Partial<Box> = {}): Box => ({
  id: "page|/clients@admin",
  screen: { key: "page|/clients", kind: "page", route: "/clients", cells: { admin: [node()] }, requirements: [] },
  user: "admin",
  nodes: [node()],
  ghost: false,
  x: 0,
  y: 0,
  h: 176,
  only: [],
  ...over,
});

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("ScreenCard", () => {
  it("names the route, the user and how the last test went, and selects on click", async () => {
    const onSelect = vi.fn();
    render(<ScreenCard box={box()} tone="failing" token="t" selected={false} onSelect={onSelect} />);
    const card = screen.getByRole("button", { name: "admin em /clients: falhou" });
    expect(within(card).getByText("/clients")).toBeInTheDocument();
    expect(within(card).getByText("admin")).toBeInTheDocument();
    await userEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows the picture of the screen, fetched with the session token", async () => {
    const calls: { path: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, auth: new Headers(init?.headers).get("authorization") });
        return new Response(new Blob(["jpeg"], { type: "image/jpeg" }), { status: 200 });
      }),
    );
    render(<ScreenCard box={box({ nodes: [node({ id: "pic-1", has_thumbnail: true })] })} tone="passed" token="dev:ana" selected={false} onSelect={() => undefined} />);
    const img = await screen.findByRole("img", { name: "Tela /clients" });
    expect(img).toHaveAttribute("src", "blob:picture");
    expect(calls).toEqual([{ path: "/api/v1/nodes/pic-1/thumbnail", auth: "Bearer dev:ana" }]);
  });

  it("does not ask for a picture the node does not have", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ScreenCard box={box({ nodes: [node({ id: "nopic" })] })} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("falls back to the placeholder when the picture cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    render(<ScreenCard box={box({ nodes: [node({ id: "gone", has_thumbnail: true })] })} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
  });

  it("flags what only this user has on a screen several users share", () => {
    render(<ScreenCard box={box({ only: ["Excluir cliente", "Aprovar", "Exportar"] })} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(screen.getByText(/só admin: Excluir cliente, Aprovar \+1/)).toBeInTheDocument();
  });

  it("says which requirement covers a page, or that none does", () => {
    const covered = box({ screen: { key: "page|/clients", kind: "page", route: "/clients", cells: { admin: [node()] }, requirements: ["REQ-001", "PAGE /clients", "FORM POST /clients"] } });
    const { unmount } = render(<ScreenCard box={covered} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(screen.getByText("REQ-001 +2")).toHaveAttribute("title", "Requisitos: REQ-001, PAGE /clients, FORM POST /clients");
    unmount();
    render(<ScreenCard box={box()} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    const none = screen.getByText("sem requisito");
    expect(none).toHaveClass("none");
    expect(none).toHaveAttribute("title", "Nenhum requisito cobre esta tela");
  });

  it("is a ghost, not a button, for a user who does not reach the screen", async () => {
    const onSelect = vi.fn();
    render(<ScreenCard box={box({ user: "operador", nodes: [], ghost: true })} tone="neutral" token="t" selected={false} onSelect={onSelect} />);
    const ghost = screen.getByLabelText("operador não alcança /clients");
    expect(ghost).toHaveTextContent("operador não alcança esta tela");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an API call as such, with what it answered or that the environment blocked it", () => {
    const ep = (observed: unknown) => box({ screen: { key: "endpoint|POST /clients", kind: "endpoint", route: "POST /clients", cells: { admin: [] }, requirements: [] }, nodes: [node({ kind: "endpoint", label: "POST /clients", metadata: { observed } })] });
    const { unmount } = render(<ScreenCard box={ep({ statuses: [302], blocked: false })} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(screen.getByText("respondeu 302")).toBeInTheDocument();
    unmount();
    render(<ScreenCard box={ep({ statuses: [], blocked: true })} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(screen.getByText(/bloqueada pela política/)).toBeInTheDocument();
  });

  it("shows only the name of a window, not the whole route", () => {
    const modal = box({ screen: { key: "modal|/clients › Novo cliente", kind: "modal", route: "/clients › Novo cliente", cells: { admin: [] }, requirements: [] }, nodes: [node({ kind: "modal", label: "/clients › Novo cliente" })] });
    render(<ScreenCard box={modal} tone="neutral" token="t" selected={false} onSelect={() => undefined} />);
    expect(screen.getByText("Novo cliente")).toBeInTheDocument();
  });
});
