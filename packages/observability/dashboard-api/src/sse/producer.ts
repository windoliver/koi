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
  // let justified: mutable counter tracking pending writes for slow-client detection
  pendingWrites: number;
  readonly logLevel?: "debug" | "info" | "warn" | "error" | undefined;
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
const MAX_BUFFER_SIZE = 1_000;

const LOG_LEVEL_HIERARCHY: Readonly<Record<string, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLogLevel(value: string | null): value is "debug" | "info" | "warn" | "error" {
  return value !== null && value in LOG_LEVEL_HIERARCHY;
}

function shouldIncludeLog(eventLevel: string, filterLevel: string): boolean {
  return (LOG_LEVEL_HIERARCHY[eventLevel] ?? 0) >= (LOG_LEVEL_HIERARCHY[filterLevel] ?? 0);
}

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
    // Backpressure: drop oldest events if buffer exceeds max size (Decision 13A)
    if (buffer.length >= MAX_BUFFER_SIZE) {
      const dropped = buffer.length - MAX_BUFFER_SIZE + 1;
      buffer = buffer.slice(dropped);
    }
    // Mutation justified: hot path in subscribe callback, buffer is replaced on flush
    buffer.push(event);
  });

  /** Max pending writes before disconnecting a slow client. */
  const MAX_PENDING_WRITES = 3;

  // Write encoded bytes to all connected clients, pruning disconnected/slow ones.
  const broadcastToAll = (encoded: Uint8Array): void => {
    const alive: SseConnection[] = [];
    for (const conn of connections) {
      if (conn.signal.aborted) continue;
      // Disconnect slow clients — EventSource auto-reconnects with Last-Event-ID
      if (conn.pendingWrites > MAX_PENDING_WRITES) {
        conn.writer.close().catch(() => {});
        continue;
      }
      conn.pendingWrites += 1;
      conn.writer
        .write(encoded)
        .then(() => {
          conn.pendingWrites -= 1;
        })
        .catch(() => {
          // Client disconnected — swallow write error
        });
      alive.push(conn);
    }
    connections = alive;
  };

  /** Filter a batch for a connection with a log level filter — removes log events below threshold. */
  const filterBatchForConnection = (
    batch: DashboardEventBatch,
    conn: SseConnection,
  ): DashboardEventBatch => {
    const filterLevel = conn.logLevel;
    if (filterLevel === undefined) return batch;
    const filtered = batch.events.filter((event) => {
      if (event.kind !== "log") return true;
      return shouldIncludeLog(event.level, filterLevel);
    });
    return { events: filtered, seq: batch.seq, timestamp: batch.timestamp };
  };

  // Write per-connection filtered batches (used when any connection has a log level filter).
  const broadcastFiltered = (batch: DashboardEventBatch, batchSeq: number): void => {
    const alive: SseConnection[] = [];
    // Cache encoded unfiltered batch for connections without a log level filter
    let unfilteredEncoded: Uint8Array | undefined;
    for (const conn of connections) {
      if (conn.signal.aborted) continue;
      if (conn.pendingWrites > MAX_PENDING_WRITES) {
        conn.writer.close().catch(() => {});
        continue;
      }
      const connBatch = filterBatchForConnection(batch, conn);
      // Skip sending empty batches after filtering
      if (connBatch.events.length === 0) {
        alive.push(conn);
        continue;
      }
      let encoded: Uint8Array;
      if (conn.logLevel === undefined) {
        if (unfilteredEncoded === undefined) {
          unfilteredEncoded = encodeSseMessageWithId(batch, String(batchSeq));
        }
        encoded = unfilteredEncoded;
      } else {
        encoded = encodeSseMessageWithId(connBatch, String(batchSeq));
      }
      conn.pendingWrites += 1;
      conn.writer
        .write(encoded)
        .then(() => {
          conn.pendingWrites -= 1;
        })
        .catch(() => {
          // Client disconnected — swallow write error
        });
      alive.push(conn);
    }
    connections = alive;
  };

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

    // When any connection has a log level filter, send per-connection filtered batches
    const hasLogFilter = connections.some((c) => c.logLevel !== undefined);
    if (!hasLogFilter) {
      broadcastToAll(encodeSseMessageWithId(batch, String(seq)));
    } else {
      broadcastFiltered(batch, seq);
    }
  };

  // Batch flush timer
  const flushTimer = setInterval(flush, options.batchIntervalMs);

  // Keepalive timer
  const keepaliveTimer = setInterval(() => {
    if (connections.length === 0) return;
    broadcastToAll(encodeSseKeepalive());
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

    // Parse log level filter from query params
    const reqUrl = new URL(req.url);
    const logLevelParam = reqUrl.searchParams.get("logLevel");
    const logLevel = isLogLevel(logLevelParam) ? logLevelParam : undefined;

    // Write an initial keepalive to unblock fetch() — without this,
    // clients block until the first batch flush or keepalive timer fires.
    writer.write(encodeSseKeepalive()).catch(() => {
      // Client disconnected before first write — swallow
    });

    const conn: SseConnection = { writer, signal, pendingWrites: 0, logLevel };
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
