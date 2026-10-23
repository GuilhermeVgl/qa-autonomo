import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type OnEvent = (e: { event: string; data: string }) => void;
const stream = vi.fn<(url: string, token: string, onEvent: OnEvent, signal: AbortSignal) => Promise<void>>();
vi.mock("./sse", () => ({ streamEvents: (url: string, token: string, onEvent: OnEvent, signal: AbortSignal) => stream(url, token, onEvent, signal) }));

import { CaptureDialog } from "./CaptureDialog";

interface Call {
  path: string;
  method: string;
  body: unknown;
}
function stubFetch(routes: Record<string, (c: Call) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: Call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const handler = routes[`${call.method} ${path}`];
      return handler ? handler(call) : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  stream.mockReset();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("CaptureDialog", () => {
  it("opens a session, shows the streamed frame and sends finish", async () => {
    stream.mockImplementation((_url, _token, onEvent) => {
      onEvent({ event: "frame", data: "QUJD" });
      return new Promise<void>(() => undefined); // stays open
    });
    const calls = stubFetch({
      "POST /api/v1/environments/e1/capture": () => json({ id: "cap1", status: "pending", app_role: "admin", start_url: "https://a.com" }, 201),
      "POST /api/v1/capture/cap1/finish": () => new Response(null, { status: 204 }),
    });
    render(<CaptureDialog token="t" envId="e1" appRole="admin" onClose={() => undefined} onDone={() => undefined} />);

    const img = (await screen.findByAltText("Navegador remoto")) as HTMLImageElement;
    expect(img.src).toContain("data:image/jpeg;base64,QUJD");

    const finish = screen.getByRole("button", { name: "Concluir login" });
    expect(finish).toBeEnabled();
    await userEvent.click(finish);
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/v1/capture/cap1/finish", method: "POST", body: undefined }));
  });

  it("calls onDone when the session ends as done", async () => {
    const onDone = vi.fn();
    stream.mockImplementation((_url, _token, onEvent) => {
      onEvent({ event: "frame", data: "QUJD" });
      onEvent({ event: "end", data: JSON.stringify({ status: "done" }) });
      return Promise.resolve();
    });
    stubFetch({ "POST /api/v1/environments/e1/capture": () => json({ id: "cap1", status: "pending", app_role: "admin", start_url: "https://a.com" }, 201) });
    render(<CaptureDialog token="t" envId="e1" appRole="admin" onClose={() => undefined} onDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
