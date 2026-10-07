import type { RunnerEvent } from "../protocol/schemas.js";

type NodePayload = Extract<RunnerEvent, { type: "node_discovered" }>["payload"];
type StepStartedPayload = Extract<RunnerEvent, { type: "step_started" }>["payload"];
type StepFinishedPayload = Extract<RunnerEvent, { type: "step_finished" }>["payload"];
type ThumbnailPayload = Extract<RunnerEvent, { type: "node_thumbnail" }>["payload"];
type EdgePayload = Extract<RunnerEvent, { type: "edge_discovered" }>["payload"];

/** Numbers events (seq, idempotent on the server) and sends them in batches. Failed batches stay buffered. */
export class EventSink {
  private seq = 0;
  private buffer: RunnerEvent[] = [];
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly send: (events: RunnerEvent[]) => Promise<void>,
    private readonly batchSize = 50,
  ) {}

  node(payload: NodePayload): void {
    this.buffer.push({ seq: ++this.seq, type: "node_discovered", payload });
  }

  nodeThumbnail(payload: ThumbnailPayload): void {
    this.buffer.push({ seq: ++this.seq, type: "node_thumbnail", payload });
  }

  edge(payload: EdgePayload): void {
    this.buffer.push({ seq: ++this.seq, type: "edge_discovered", payload });
  }

  stepStarted(payload: StepStartedPayload): void {
    this.buffer.push({ seq: ++this.seq, type: "step_started", payload });
  }

  stepFinished(payload: StepFinishedPayload): void {
    this.buffer.push({ seq: ++this.seq, type: "step_finished", payload });
  }

  /** Sends what is buffered; calls are chained so batches never overlap and always go out in order. */
  flush(): Promise<void> {
    const next = (this.inflight ?? Promise.resolve()).catch(() => undefined).then(() => this.drain());
    this.inflight = next;
    return next;
  }

  /**
   * Flushes every `intervalMs` while the job runs, so the control plane (and the live graph) see events as they
   * happen instead of all at once at the end. A failed tick leaves the events buffered for the next one.
   */
  startAutoFlush(intervalMs = 1000): () => void {
    const timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs);
    return () => clearInterval(timer);
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, this.batchSize);
      await this.send(batch);
      this.buffer = this.buffer.slice(batch.length);
    }
  }
}
