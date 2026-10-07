export interface SSEEvent {
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parser (EventSource cannot send an Authorization header, so we use fetch). */
export class SSEParser {
  private buffer = "";

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      let any = false;
      for (const line of block.split("\n")) {
        if (line.startsWith(":") || line === "") continue;
        any = true;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (any) events.push({ event, data: data.join("\n") });
    }
    return events;
  }
}

/** Streams events from `url` until the server closes it or `signal` aborts. */
export async function streamEvents(
  url: string,
  token: string,
  onEvent: (e: SSEEvent) => void,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal });
  if (!res.ok || !res.body) throw new Error(`stream failed with status ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
  }
}
