/**
 * Mock Gateway WebSocket server for integration tests.
 *
 * Uses Bun.serve() to create a real WS server that simulates the Koi Gateway.
 * Tracks connected clients, received frames, and supports frame injection.
 */

import type { Server, ServerWebSocket } from "bun";
import type { NodeFrame } from "../../src/types.js";

export interface MockGateway {
  /** The URL to connect to (e.g. "ws://localhost:12345"). */
  readonly url: string;
  /** The actual port assigned by the OS. */
  readonly port: number;
  /** All frames received from connected nodes. */
  readonly receivedFrames: readonly NodeFrame[];
  /** Number of currently connected clients. */
  readonly clientCount: () => number;
  /** Send a frame to all connected clients. */
  readonly broadcast: (frame: NodeFrame) => void;
  /** Send a frame to a specific client by index. */
  readonly sendTo: (clientIndex: number, frame: NodeFrame) => void;
  /** Close all connected clients with the given code. */
  readonly disconnectAll: (code?: number, reason?: string) => void;
  /** Shut down the server completely. */
  readonly close: () => void;
  /** Wait for at least N frames to arrive. */
  readonly waitForFrames: (count: number, timeoutMs?: number) => Promise<readonly NodeFrame[]>;
  /** Wait for at least N clients to connect. */
  readonly waitForClients: (count: number, timeoutMs?: number) => Promise<void>;
}

export function createMockGateway(): MockGateway {
  const receivedFrames: NodeFrame[] = [];
  const clients: ServerWebSocket<unknown>[] = [];
  const frameWaiters: Array<{ count: number; resolve: () => void }> = [];
  const clientWaiters: Array<{ count: number; resolve: () => void }> = [];

  function checkFrameWaiters(): void {
    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      const waiter = frameWaiters[i];
      if (waiter !== undefined && receivedFrames.length >= waiter.count) {
        waiter.resolve();
        frameWaiters.splice(i, 1);
      }
    }
  }

  function checkClientWaiters(): void {
    for (let i = clientWaiters.length - 1; i >= 0; i--) {
      const waiter = clientWaiters[i];
      if (waiter !== undefined && clients.length >= waiter.count) {
        waiter.resolve();
        clientWaiters.splice(i, 1);
      }
    }
  }

  const server: Server = Bun.serve({
    port: 0, // OS-assigned port
    fetch(req, server) {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      open(ws) {
        clients.push(ws);
        checkClientWaiters();
      },
      message(_ws, message) {
        try {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
            return;
          }
          receivedFrames.push(parsed as NodeFrame);
          checkFrameWaiters();
        } catch (e: unknown) {
          // Log but don't throw — test infra should be resilient to malformed frames
          console.warn("[MockGateway] Failed to parse incoming message:", e);
        }
      },
      close(ws) {
        const idx = clients.indexOf(ws);
        if (idx >= 0) {
          clients.splice(idx, 1);
        }
      },
    },
  });

  return {
    url: `ws://localhost:${server.port}`,
    port: server.port,
    receivedFrames,

    clientCount() {
      return clients.length;
    },

    broadcast(frame) {
      const data = JSON.stringify(frame);
      for (const client of clients) {
        client.send(data);
      }
    },

    sendTo(clientIndex, frame) {
      const client = clients[clientIndex];
      if (client !== undefined) {
        client.send(JSON.stringify(frame));
      }
    },

    disconnectAll(code = 1000, reason = "test disconnect") {
      for (const client of [...clients]) {
        client.close(code, reason);
      }
    },

    close() {
      for (const client of [...clients]) {
        client.close(1000, "server closing");
      }
      clients.length = 0;
      server.stop(true);
    },

    waitForFrames(count, timeoutMs = 5_000) {
      if (receivedFrames.length >= count) {
        return Promise.resolve(receivedFrames);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${count} frames (got ${receivedFrames.length})`));
        }, timeoutMs);

        frameWaiters.push({
          count,
          resolve() {
            clearTimeout(timer);
            resolve(receivedFrames);
          },
        });
      });
    },

    waitForClients(count, timeoutMs = 5_000) {
      if (clients.length >= count) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${count} clients (got ${clients.length})`));
        }, timeoutMs);

        clientWaiters.push({
          count,
          resolve() {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };
}
