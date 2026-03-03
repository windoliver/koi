/**
 * SSE producer — manages connections and 100ms event batching.
 *
 * Subscribes to DashboardDataSource.subscribe() for events, buffers
 * them in-memory, and flushes every sseBatchIntervalMs as a
 * DashboardEventBatch to all connected clients.
 */

import type {
  DashboardDataSource,
  DashboardEvent,
  DashboardEventBatch,
} from "@koi/dashboard-types";
import { encodeSseKeepalive, encodeSseMessageWithId } from "./encoder.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SseConnection {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly signal: AbortSignal;
}

export interface SseProducer {
  /** Create a new SSE Response for a client connection. Returns 503 if at capacity. Extra headers merged into response. */
  readonly connect: (req: Request, extraHeaders?: Readonly<Record<string, string>>) => Response;
  /** Number of active SSE connections. */
  readonly connectionCount: () => number;
  /** Shut down the producer — flush remaining events, close all connections, stop timers. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEEPALIVE_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSseProducer(
  dataSource: DashboardDataSource,
  options: {
    readonly batchIntervalMs: number;
    readonly maxConnections: number;
  },
): SseProducer {
  let connections: readonly SseConnection[] = [];
  let buffer: DashboardEvent[] = [];
  // let is justified: monotonically increasing counter
  let seq = 0;
  let disposed = false;

  // Subscribe to data source events — skip buffering when no clients connected
  const unsubscribe = dataSource.subscribe((event: DashboardEvent) => {
    if (disposed || connections.length === 0) return;
    // Mutation justified: hot path in subscribe callback, buffer is replaced on flush
    buffer.push(event);
  });

  // Flush buffered events to all connected clients
  const flush = (): void => {
    if (buffer.length === 0) return;
    // Drain stale events if no clients are connected
    if (connections.length === 0) {
      buffer = [];
      return;
    }

    seq += 1;
    const batch: DashboardEventBatch = {
      events: [...buffer],
      seq,
      timestamp: Date.now(),
    };
    buffer = [];

    const encoded = encodeSseMessageWithId(batch, String(seq));
    const alive: SseConnection[] = [];

    for (const conn of connections) {
      if (conn.signal.aborted) continue;
      conn.writer.write(encoded).catch(() => {
        // Client disconnected — swallow write error
      });
      alive.push(conn);
    }

    connections = alive;
  };

  // Batch flush timer
  const flushTimer = setInterval(flush, options.batchIntervalMs);

  // Keepalive timer
  const keepaliveTimer = setInterval(() => {
    if (connections.length === 0) return;
    const encoded = encodeSseKeepalive();
    const alive: SseConnection[] = [];

    for (const conn of connections) {
      if (conn.signal.aborted) continue;
      conn.writer.write(encoded).catch(() => {
        // Client disconnected — swallow write error
      });
      alive.push(conn);
    }

    connections = alive;
  }, KEEPALIVE_INTERVAL_MS);

  const connect = (req: Request, extraHeaders?: Readonly<Record<string, string>>): Response => {
    if (disposed) {
      return new Response(
        JSON.stringify({ ok: false, error: { code: "GONE", message: "SSE producer is disposed" } }),
        {
          status: 410,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (connections.length >= options.maxConnections) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Too many SSE connections" },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }),
      new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }),
    );

    const writer = writable.getWriter();
    const signal = req.signal;

    // Write an initial keepalive to unblock fetch() — without this,
    // clients block until the first batch flush or keepalive timer fires.
    writer.write(encodeSseKeepalive()).catch(() => {
      // Client disconnected before first write — swallow
    });

    const conn: SseConnection = { writer, signal };
    connections = [...connections, conn];

    // Auto-cleanup on client disconnect
    signal.addEventListener("abort", () => {
      connections = connections.filter((c) => c !== conn);
      writer.close().catch(() => {
        // Already closed — swallow
      });
    });

    // Support Last-Event-ID for reconnection — client gets events from seq+1
    // For V1, we don't replay missed events (would need a ring buffer).
    // The client will get a full state refresh via REST on reconnect.

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...extraHeaders,
      },
    });
  };

  const connectionCount = (): number => connections.length;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    // Flush remaining events
    flush();

    // Stop timers
    clearInterval(flushTimer);
    clearInterval(keepaliveTimer);

    // Unsubscribe from data source
    unsubscribe();

    // Close all connections
    for (const conn of connections) {
      conn.writer.close().catch(() => {
        // Already closed — swallow
      });
    }
    connections = [];
  };

  return { connect, connectionCount, dispose };
}
