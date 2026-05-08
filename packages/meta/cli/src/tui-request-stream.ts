import type { EngineEvent } from "@koi/core";

interface ResponseFrameLike {
  readonly kind?: string;
  readonly ref?: string;
  readonly payload?: unknown;
}

export interface RequestStream {
  readonly iterator: AsyncIterable<EngineEvent>;
}

const EMPTY_METRICS = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
} as const;

function makeTerminator(
  push: (event: EngineEvent) => void,
  state: { terminated: boolean },
): (reason: "completed" | "error", text?: string) => void {
  return (reason, text) => {
    if (state.terminated) return;
    state.terminated = true;
    push({
      kind: "done",
      output: {
        stopReason: reason,
        content: text !== undefined && text.length > 0 ? [{ kind: "text", text }] : [],
        metrics: EMPTY_METRICS,
      },
    } satisfies EngineEvent);
  };
}

function makeMessageHandler(
  requestId: string,
  push: (event: EngineEvent) => void,
  terminate: (reason: "completed" | "error", text?: string) => void,
): (ev: MessageEvent) => void {
  return (ev) => {
    let frame: ResponseFrameLike;
    try {
      frame = JSON.parse(String(ev.data)) as ResponseFrameLike;
    } catch {
      return;
    }
    if (frame.ref !== requestId) return;
    if (frame.kind === "response") {
      const payload = frame.payload as { readonly text?: unknown } | undefined;
      const text = typeof payload?.text === "string" ? payload.text : undefined;
      if (text !== undefined && text.length > 0) {
        push({ kind: "text_delta", delta: text } satisfies EngineEvent);
      }
      terminate("completed", text);
    } else if (frame.kind === "error") {
      terminate("error");
    }
  };
}

async function* drain(
  queue: EngineEvent[],
  waiters: Array<() => void>,
  detach: () => void,
): AsyncIterable<EngineEvent> {
  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      const next = queue.shift();
      if (next === undefined) continue;
      yield next;
      if (next.kind === "done") return;
    }
  } finally {
    detach();
  }
}

export function createRequestStream(socket: WebSocket, requestId: string): RequestStream {
  const queue: EngineEvent[] = [];
  const waiters: Array<() => void> = [];
  const state = { terminated: false };
  const push = (event: EngineEvent): void => {
    queue.push(event);
    waiters.shift()?.();
  };
  const terminate = makeTerminator(push, state);
  const onMessage = makeMessageHandler(requestId, push, terminate);
  const onClose = (): void => terminate("error");
  const onError = (): void => terminate("error");

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);

  const detach = (): void => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
  };

  return { iterator: drain(queue, waiters, detach) };
}
