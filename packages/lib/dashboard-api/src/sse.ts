import type { WsEvent, WsTopic } from "@koi/dashboard-types";

import { parseEventSubscription } from "./query.js";
import type { DashboardDataSource } from "./types.js";

/**
 * One SSE batch frame. Clients reassemble events from `events` array.
 * `seq` is monotonic per-connection, used for client-side deduplication.
 */
export interface EventBatch {
  readonly seq: number;
  readonly timestampMs: number;
  readonly events: readonly WsEvent[];
}

export interface SseConfig {
  readonly flushMs: number;
  readonly bufferLimit: number;
  /** Heartbeat interval in ms. */
  readonly heartbeatMs: number;
}

export const DEFAULT_SSE_CONFIG: SseConfig = Object.freeze({
  flushMs: 100,
  bufferLimit: 1000,
  heartbeatMs: 15_000,
});

/**
 * Build a `text/event-stream` response that fans events from a data source to
 * the client. Tears down on client disconnect (TransformStream.cancel).
 */
export function handleEvents(url: URL, source: DashboardDataSource, config: SseConfig): Response {
  const subscription = parseEventSubscription(url);
  const allowed = new Set(subscription.topics);
  const stream = new SseStream(source, allowed, config);
  return new Response(stream.readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Internal event-stream pump: subscribes to the data source, batches events
 * at `flushMs` cadence, drops oldest on overflow, and emits heartbeats.
 */
class SseStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly #writable: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();
  readonly #unsubscribe: () => void;
  #buffer: WsEvent[] = [];
  #seq = 0;
  #closed = false;
  readonly #flushTimer: ReturnType<typeof setInterval>;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  readonly #bufferLimit: number;

  constructor(source: DashboardDataSource, topics: ReadonlySet<WsTopic>, config: SseConfig) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = readable;
    this.#writable = writable.getWriter();
    this.#bufferLimit = config.bufferLimit;

    this.#unsubscribe = source.subscribe((event) => {
      if (this.#closed) return;
      if (!topics.has(event.kind as WsTopic)) return;
      if (this.#buffer.length >= this.#bufferLimit) {
        // Drop oldest — preserve newest events for the client.
        this.#buffer = this.#buffer.slice(this.#buffer.length - this.#bufferLimit + 1);
      }
      this.#buffer = [...this.#buffer, event];
    });

    this.#flushTimer = setInterval(() => {
      void this.#flush();
    }, config.flushMs);

    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, config.heartbeatMs);

    void this.#monitorClose();
  }

  async #flush(): Promise<void> {
    if (this.#closed || this.#buffer.length === 0) return;
    const events = this.#buffer;
    this.#buffer = [];
    this.#seq += 1;
    const batch: EventBatch = {
      seq: this.#seq,
      timestampMs: Date.now(),
      events,
    };
    const frame = `event: batch\ndata: ${JSON.stringify(batch)}\n\n`;
    try {
      await this.#writable.write(this.#encoder.encode(frame));
    } catch {
      this.#close();
    }
  }

  async #heartbeat(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#writable.write(this.#encoder.encode(": ping\n\n"));
    } catch {
      this.#close();
    }
  }

  async #monitorClose(): Promise<void> {
    try {
      await this.#writable.closed;
    } catch {
      // expected on client disconnect
    }
    this.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#flushTimer);
    clearInterval(this.#heartbeatTimer);
    this.#unsubscribe();
    this.#writable.close().catch(() => {
      // already closed
    });
  }
}
