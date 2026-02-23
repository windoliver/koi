/**
 * Transport abstraction over WebSocket server lifecycle.
 */

// ---------------------------------------------------------------------------
// Connection handle
// ---------------------------------------------------------------------------

/**
 * Matches Bun's ServerWebSocket.send() semantics:
 * -1 = backpressure (queued), 0 = dropped/closed, >0 = bytes sent.
 */
export type TransportSendResult = -1 | 0 | number;

export interface TransportConnection {
  readonly id: string;
  readonly send: (data: string) => TransportSendResult;
  readonly close: (code?: number, reason?: string) => void;
  readonly remoteAddress: string;
}

// ---------------------------------------------------------------------------
// Handler (events from transport → gateway)
// ---------------------------------------------------------------------------

export interface TransportHandler {
  readonly onOpen: (conn: TransportConnection) => void;
  readonly onMessage: (conn: TransportConnection, data: string) => void;
  readonly onClose: (conn: TransportConnection, code: number, reason: string) => void;
  readonly onDrain: (conn: TransportConnection) => void;
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface Transport {
  readonly listen: (port: number, handler: TransportHandler) => Promise<void>;
  readonly close: () => void;
  readonly connections: () => number;
}

// ---------------------------------------------------------------------------
// BunTransport — wraps Bun.serve() WebSocket
// ---------------------------------------------------------------------------

export interface BunTransport extends Transport {
  /** The actual port the server is listening on (useful when binding to port 0). */
  readonly port: () => number;
}

export function createBunTransport(): BunTransport {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let connectionCount = 0;

  return {
    port(): number {
      if (server === undefined) throw new Error("Transport not started");
      const p = server.port;
      if (p === undefined) throw new Error("Server port not available");
      return p;
    },
    listen(port: number, handler: TransportHandler): Promise<void> {
      // Map from Bun's ServerWebSocket id → TransportConnection
      const connMap = new Map<string, TransportConnection>();
      const decoder = new TextDecoder();

      server = Bun.serve({
        port,
        fetch(req, srv) {
          const upgraded = srv.upgrade(req, {
            data: { id: crypto.randomUUID() },
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade required", { status: 426 });
          }
          return undefined;
        },
        websocket: {
          open(ws) {
            const id = (ws.data as { readonly id: string }).id;
            const conn: TransportConnection = {
              id,
              send: (data: string) => ws.send(data) as TransportSendResult,
              close: (code?: number, reason?: string) => ws.close(code, reason),
              remoteAddress: ws.remoteAddress,
            };
            connMap.set(id, conn);
            connectionCount++;
            handler.onOpen(conn);
          },
          message(ws, message) {
            const id = (ws.data as { readonly id: string }).id;
            const conn = connMap.get(id);
            if (conn === undefined) return;
            const data = typeof message === "string" ? message : decoder.decode(message);
            handler.onMessage(conn, data);
          },
          close(ws, code, reason) {
            const id = (ws.data as { readonly id: string }).id;
            const conn = connMap.get(id);
            if (conn === undefined) return;
            connMap.delete(id);
            connectionCount--;
            handler.onClose(conn, code, reason);
          },
          drain(ws) {
            const id = (ws.data as { readonly id: string }).id;
            const conn = connMap.get(id);
            if (conn === undefined) return;
            handler.onDrain(conn);
          },
        },
      });

      return Promise.resolve();
    },

    close(): void {
      server?.stop(true);
      server = undefined;
      connectionCount = 0;
    },

    connections(): number {
      return connectionCount;
    },
  };
}
