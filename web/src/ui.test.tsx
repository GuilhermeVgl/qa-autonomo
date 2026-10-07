import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, Segmented, ToastProvider, useToast } from "./ui";

afterEach(() => vi.useRealTimers());

function Trigger({ run }: { run: (t: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => run(toast)}>
      go
    </button>
  );
}

describe("toasts", () => {
  it("shows a message and removes it by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Trigger run={(t) => t.show({ kind: "success", title: "Spec salva", text: "3 requisitos" })} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByText("Spec salva")).toBeInTheDocument();
    expect(screen.getByText("3 requisitos")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText("Spec salva")).not.toBeInTheDocument();
  });

  it("keeps a loading toast until the work is done, then turns it into the result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let handle: ReturnType<ReturnType<typeof useToast>["loading"]> | undefined;
    render(
      <ToastProvider>
        <Trigger run={(t) => (handle = t.loading("Cruzando requisitos…"))} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText("Cruzando requisitos…")).toBeInTheDocument();
    act(() => handle?.done("Cruzamento concluído", "12 ligações"));
    expect(screen.queryByText("Cruzando requisitos…")).not.toBeInTheDocument();
    expect(screen.getByText("Cruzamento concluído")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText("Cruzamento concluído")).not.toBeInTheDocument();
  });

  it("can be closed by hand", async () => {
    render(
      <ToastProvider>
        <Trigger run={(t) => t.show({ kind: "error", title: "Falhou" })} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await userEvent.click(screen.getByRole("button", { name: /Fechar notificação/ }));
    expect(screen.queryByText("Falhou")).not.toBeInTheDocument();
  });

  it("does nothing without a provider (components stay testable on their own)", async () => {
    render(<Trigger run={(t) => t.show({ title: "x" })} />);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.queryByText("x")).not.toBeInTheDocument();
  });
});

describe("Modal", () => {
  it("is a labelled dialog that closes with Escape, the close button or a click outside", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Nova especificação" onClose={onClose}>
        <p>conteúdo</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Nova especificação" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    await userEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("cannot be dismissed while it is busy", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Enviando" onClose={onClose} busy>
        <p>aguarde</p>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Fechar" })).not.toBeInTheDocument();
  });
});

describe("Segmented", () => {
  it("is a radio group that reports the choice", async () => {
    const onChange = vi.fn();
    render(<Segmented label="Tema" value="light" onChange={onChange} options={[{ value: "light", label: "Claro" }, { value: "dark", label: "Escuro" }]} />);
    expect(screen.getByRole("radio", { name: "Claro" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Escuro" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});
