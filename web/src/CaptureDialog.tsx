import { useEffect, useRef, useState } from "react";
import { api, type Capture } from "./api";
import { Icon } from "./icons";
import { streamEvents } from "./sse";

type Phase = "starting" | "live" | "ended";
interface Input {
  type: "move" | "click" | "wheel" | "key" | "text";
  x?: number;
  y?: number;
  button?: string;
  dy?: number;
  key?: string;
  text?: string;
}

/**
 * Remote-browser session capture: the runner opens a browser, streams its screen here as JPEG frames, and we send back
 * the person's clicks and keystrokes. When they finish logging in, the runner saves the authenticated session. This is
 * how the agent gets past SSO/2FA/captcha — a person does the login once, here, in the app.
 */
export function CaptureDialog({ token, envId, appRole, onClose, onDone }: { token: string; envId: string; appRole: string; onClose: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [frame, setFrame] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const pending = useRef<Input[]>([]);
  const startedAt = useRef<number>(Date.now());
  const sawFrameAt = useRef<number>(0);
  const ended = useRef<boolean>(false);
  const surface = useRef<HTMLDivElement>(null);
  // Kept in a ref so a new onDone identity from the parent never restarts the capture (which would renavigate and blank the screen).
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Start the session once per open, stream frames, and flush queued input; everything is torn down on unmount.
  useEffect(() => {
    const abort = new AbortController();
    let flush: ReturnType<typeof setInterval> | undefined;
    let statusPoll: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const finishWith = (status: string) => {
      if (ended.current) return;
      ended.current = true;
      setPhase("ended");
      if (status === "done") onDoneRef.current();
      else setMessage(status === "canceled" ? "Captura cancelada." : "Não foi possível capturar a sessão.");
    };
    void (async () => {
      try {
        const c = await api<Capture>(`/api/v1/environments/${envId}/capture`, token, { method: "POST", body: JSON.stringify({ app_role: appRole }) });
        if (closed) return;
        idRef.current = c.id;
        startedAt.current = Date.now();
        flush = setInterval(() => {
          const batch = pending.current;
          if (batch.length === 0 || !idRef.current) return;
          pending.current = [];
          void api(`/api/v1/capture/${idRef.current}/input`, token, { method: "POST", body: JSON.stringify({ events: batch }) }).catch(() => undefined);
        }, 70);
        statusPoll = setInterval(() => {
          const id = idRef.current;
          if (!id || closed) return;
          const wait = Date.now() - startedAt.current;
          const quiet = sawFrameAt.current > 0 ? Date.now() - sawFrameAt.current : wait;
          if (sawFrameAt.current === 0 && wait > 15_000) {
            setMessage("Aguardando um runner disponível para abrir o navegador remoto…");
          }
          if (sawFrameAt.current === 0 && quiet > 30_000) {
            setMessage("A captura ainda não exibiu tela. Verifique se há runner ativo e se outra captura não está em andamento.");
          }
          if (sawFrameAt.current === 0 && wait > 90_000 && !ended.current) {
            ended.current = true;
            setPhase("ended");
            setMessage("A captura expirou sem abrir o navegador remoto. Tente novamente; uma sessão de captura anterior pode ter travado.");
            void api(`/api/v1/capture/${id}/cancel`, token, { method: "POST" }).catch(() => undefined);
            return;
          }
          void api<Capture>(`/api/v1/capture/${id}`, token)
            .then((v) => {
              if (v.status === "done" || v.status === "failed" || v.status === "canceled") finishWith(v.status);
            })
            .catch(() => undefined);
        }, 3_000);
        await streamEvents(
          `/api/v1/capture/${c.id}/stream`,
          token,
          (e) => {
            if (e.event === "frame") {
              setFrame(e.data);
              sawFrameAt.current = Date.now();
              setMessage(null);
              setPhase("live");
            } else if (e.event === "end") {
              const status = (JSON.parse(e.data || "{}") as { status?: string }).status;
              finishWith(status ?? "failed");
            }
          },
          abort.signal,
        );
        if (!closed && !ended.current && idRef.current) {
          // Stream ended without a terminal event (proxy/network hiccup): close this session so it does not block the next one.
          ended.current = true;
          setPhase("ended");
          setMessage("A conexão da captura foi interrompida. Abra novamente para continuar.");
          void api(`/api/v1/capture/${idRef.current}/cancel`, token, { method: "POST" }).catch(() => undefined);
        }
      } catch (err) {
        if (!closed) setMessage(err instanceof Error ? err.message : "Falha ao iniciar a captura.");
      }
    })();
    return () => {
      closed = true;
      abort.abort();
      if (flush) clearInterval(flush);
      if (statusPoll) clearInterval(statusPoll);
    };
  }, [envId, appRole, token]);

  useEffect(() => surface.current?.focus(), [phase]);

  function send(ev: Input) {
    pending.current.push(ev);
  }
  function point(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const img = surface.current?.querySelector("img");
    if (!img) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  function finish() {
    if (idRef.current) void api(`/api/v1/capture/${idRef.current}/finish`, token, { method: "POST" }).catch(() => undefined);
  }
  function cancel() {
    if (idRef.current) void api(`/api/v1/capture/${idRef.current}/cancel`, token, { method: "POST" }).catch(() => undefined);
    onClose();
  }

  return (
    <div className="modal-backdrop" data-testid="capture-backdrop">
      <div className="modal wide capture" role="dialog" aria-modal="true" aria-label="Capturar sessão">
        <header className="modal-head">
          <div>
            <h2>Capturar sessão · {appRole}</h2>
            <p className="meta">Faça o login no navegador abaixo (SSO, 2FA, captcha — o que o app pedir). Ao terminar, clique em “Concluir login”.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={cancel}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div
          className="capture-surface"
          ref={surface}
          tabIndex={0}
          role="application"
          aria-label="Navegador remoto"
          onKeyDown={(e) => {
            if (phase !== "live") return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({ type: "text", text: e.key });
            else send({ type: "key", key: e.key });
          }}
          onClick={(e) => {
            const p = point(e);
            if (p && phase === "live") {
              surface.current?.focus();
              send({ type: "click", x: p.x, y: p.y });
            }
          }}
          onWheel={(e) => {
            const p = point(e);
            if (p && phase === "live") send({ type: "wheel", x: p.x, y: p.y, dy: e.deltaY });
          }}
        >
          {frame ? (
            <img src={`data:image/jpeg;base64,${frame}`} alt="Navegador remoto" draggable={false} />
          ) : (
            <div className="capture-waiting">
              {message ? <p role="alert">{message}</p> : <p>Aguardando o runner abrir o navegador…</p>}
            </div>
          )}
          {phase === "ended" && message && (
            <div className="capture-waiting over">
              <p role="alert">{message}</p>
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={cancel}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={phase !== "live"} onClick={finish}>
            Concluir login
          </button>
        </footer>
      </div>
    </div>
  );
}
