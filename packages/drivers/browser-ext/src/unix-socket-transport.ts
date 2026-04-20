import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import type {
  AdminClearGrantsAckFailFrame,
  AdminClearGrantsAckOkFrame,
  AdminClearGrantsFrame,
  AttachAckFailFrame,
  AttachAckOkFrame,
  CdpErrorFrame,
  CdpEventFrame,
  CdpFrame,
  CdpResultFrame,
  DriverFrame,
  HelloAckFailFrame,
  HelloAckOkFrame,
  HelloFrame,
  TabsFrame,
} from "./native-host/driver-frame.js";
import { DriverFrameSchema } from "./native-host/driver-frame.js";
import { createFrameReader } from "./native-host/frame-reader.js";
import { createFrameWriter } from "./native-host/frame-writer.js";

export type AdminClearGrantsAckFrame = AdminClearGrantsAckOkFrame | AdminClearGrantsAckFailFrame;

export interface DriverClient {
  readonly connect: () => Promise<void>;
  readonly hello: (frame: HelloFrame) => Promise<HelloAckOkFrame | HelloAckFailFrame>;
  readonly listTabs: () => Promise<TabsFrame>;
  readonly adminClearGrants: (frame: AdminClearGrantsFrame) => Promise<AdminClearGrantsAckFrame>;
  readonly attach: (
    frame: Extract<DriverFrame, { kind: "attach" }>,
  ) => Promise<AttachAckOkFrame | AttachAckFailFrame>;
  /**
   * Send a `detach` frame for the given session AND wait for the host's
   * `detach_ack`. Resolves with the ack frame so callers can distinguish
   * success vs. `not_attached`/`chrome_error`/`timeout`. This is the
   * correct bridge-shutdown primitive — fire-and-forget detach leaves the
   * host in `detaching_failed` state if the ack is lost.
   */
  readonly detach: (
    sessionId: string,
    timeoutMs?: number,
  ) => Promise<Extract<DriverFrame, { kind: "detach_ack" }>>;
  readonly sendCdpFrame: (frame: CdpFrame) => Promise<void>;
  /**
   * Singleton-slot handler. `setFrameHandler(null)` clears it. Prefer
   * `subscribeFrames` for multi-listener use (e.g., multiple loopback WS
   * bridges sharing one DriverClient).
   */
  readonly setFrameHandler: (handler: ((frame: DriverFrame) => void) | null) => void;
  /**
   * Register an additional frame listener. Multiple subscribers are allowed
   * — typically each bridge filters by its own sessionId. Returns an
   * unsubscribe function.
   */
  readonly subscribeFrames: (listener: (frame: DriverFrame) => void) => () => void;
  readonly setCloseHandler: (handler: (() => void) | null) => void;
  readonly close: () => Promise<void>;
}

export interface DriverClientOptions {
  readonly socketPath?: string | undefined;
  readonly connectSocket?: (() => Socket | Duplex) | undefined;
}

interface PendingFrameWaiter<TFrame extends DriverFrame> {
  readonly predicate: (frame: DriverFrame) => frame is TFrame;
  readonly resolve: (frame: DriverFrame) => void;
  readonly reject: (error: Error) => void;
}

export interface LoopbackWebSocketBridge {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

export interface LoopbackWebSocketBridgeOptions {
  readonly token: string;
  readonly sessionId: string;
  readonly transport: Pick<DriverClient, "sendCdpFrame" | "subscribeFrames" | "detach">;
}

export interface LoopbackUpgradeSocket {
  readonly write: (data: string) => void;
  readonly destroy: () => void;
}

export interface LoopbackWebSocketPeer {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly on: {
    (event: "message", listener: (data: WebSocket.RawData) => void): unknown;
    (event: "close", listener: () => void): unknown;
  };
}

export interface LoopbackServerLike {
  readonly on: (
    event: "upgrade",
    listener: (request: IncomingMessage, socket: LoopbackUpgradeSocket, head: Buffer) => void,
  ) => unknown;
}

export interface LoopbackWebSocketServerLike {
  readonly handleUpgrade: (
    request: IncomingMessage,
    socket: LoopbackUpgradeSocket,
    head: Buffer,
    callback: (socket: LoopbackWebSocketPeer) => void,
  ) => void;
}

function parseFrame(json: string): DriverFrame {
  return DriverFrameSchema.parse(JSON.parse(json));
}

export function createDriverClient(options: string | DriverClientOptions): DriverClient {
  const socketPath = typeof options === "string" ? options : options.socketPath;
  const connectSocket = typeof options === "string" ? undefined : options.connectSocket;
  let socket: Socket | null = null;
  let connected = false;
  let writer: ReturnType<typeof createFrameWriter> | null = null;
  let frameHandler: ((frame: DriverFrame) => void) | null = null;
  const frameSubscribers = new Set<(frame: DriverFrame) => void>();
  let closeHandler: (() => void) | null = null;
  const pending: PendingFrameWaiter<DriverFrame>[] = [];

  function rejectAll(error: Error): void {
    while (pending.length > 0) {
      pending.shift()?.reject(error);
    }
  }

  async function writeFrame(frame: DriverFrame): Promise<void> {
    if (writer === null) {
      throw new Error("Driver client is not connected");
    }
    await writer.write(JSON.stringify(frame));
  }

  function waitFor<TFrame extends DriverFrame>(
    predicate: (frame: DriverFrame) => frame is TFrame,
  ): Promise<TFrame> {
    return new Promise<TFrame>((resolve, reject) => {
      pending.push({
        predicate,
        resolve: (frame: DriverFrame): void => resolve(frame as TFrame),
        reject,
      });
    });
  }

  async function startReader(activeSocket: Socket | Duplex): Promise<void> {
    try {
      for await (const payload of createFrameReader(activeSocket)) {
        const frame = parseFrame(payload);
        const index = pending.findIndex((waiter) => waiter.predicate(frame));
        if (index >= 0) {
          const waiter = pending.splice(index, 1)[0];
          waiter?.resolve(frame);
          continue;
        }
        frameHandler?.(frame);
        // Fan out to multi-listener subscribers. Snapshot the set before
        // iterating so an unsubscribe during dispatch doesn't skip callbacks.
        const snapshot = Array.from(frameSubscribers);
        for (const listener of snapshot) {
          try {
            listener(frame);
          } catch {
            // Listener errors must not abort the reader loop.
          }
        }
      }
    } catch (error) {
      rejectAll(error instanceof Error ? error : new Error(String(error)));
    } finally {
      connected = false;
      closeHandler?.();
    }
  }

  return {
    async connect(): Promise<void> {
      if (connected) {
        return;
      }
      const activeSocket =
        connectSocket?.() ??
        (() => {
          if (socketPath === undefined) {
            throw new Error("Driver client requires either socketPath or connectSocket");
          }
          return createConnection(socketPath);
        })();
      socket = activeSocket as Socket;
      writer = createFrameWriter(activeSocket);
      if (connectSocket === undefined) {
        await new Promise<void>((resolve, reject) => {
          (activeSocket as Socket).once("connect", () => {
            connected = true;
            resolve();
          });
          (activeSocket as Socket).once("error", reject);
        });
      } else {
        connected = true;
      }
      void startReader(activeSocket);
    },
    async hello(frame: HelloFrame): Promise<HelloAckOkFrame | HelloAckFailFrame> {
      // Register the waiter BEFORE writing so a fast host reply cannot race
      // past an un-registered listener and be dropped.
      const waiter = waitFor(
        (candidate): candidate is HelloAckOkFrame | HelloAckFailFrame =>
          candidate.kind === "hello_ack",
      );
      await writeFrame(frame);
      return waiter;
    },
    async listTabs(): Promise<TabsFrame> {
      const requestId = randomUUID();
      const waiter = waitFor(
        (candidate): candidate is TabsFrame =>
          candidate.kind === "tabs" && candidate.requestId === requestId,
      );
      await writeFrame({ kind: "list_tabs", requestId });
      return waiter;
    },
    async adminClearGrants(frame: AdminClearGrantsFrame): Promise<AdminClearGrantsAckFrame> {
      const waiter = waitFor(
        (candidate): candidate is AdminClearGrantsAckFrame =>
          candidate.kind === "admin_clear_grants_ack",
      );
      await writeFrame(frame as DriverFrame);
      return waiter;
    },
    async attach(
      frame: Extract<DriverFrame, { kind: "attach" }>,
    ): Promise<AttachAckOkFrame | AttachAckFailFrame> {
      const waiter = waitFor(
        (candidate): candidate is AttachAckOkFrame | AttachAckFailFrame =>
          candidate.kind === "attach_ack" && candidate.attachRequestId === frame.attachRequestId,
      );
      await writeFrame(frame);
      return waiter;
    },
    async detach(
      sessionId: string,
      timeoutMs = 5_000,
    ): Promise<Extract<DriverFrame, { kind: "detach_ack" }>> {
      // Register the waiter inline so the timeout path can remove it from
      // `pending`. If we leave a stale waiter in place on timeout, a late
      // detach_ack will be consumed by the already-rejected waiter and every
      // retry for the same sessionId will time out as well.
      type AckFrame = Extract<DriverFrame, { kind: "detach_ack" }>;
      const predicate = (candidate: DriverFrame): candidate is AckFrame =>
        candidate.kind === "detach_ack" && candidate.sessionId === sessionId;
      const ack = await new Promise<AckFrame>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const entry: PendingFrameWaiter<DriverFrame> = {
          predicate,
          resolve: (frame: DriverFrame): void => {
            if (timer) clearTimeout(timer);
            resolve(frame as AckFrame);
          },
          reject: (err: Error): void => {
            if (timer) clearTimeout(timer);
            reject(err);
          },
        };
        pending.push(entry);
        timer = setTimeout(() => {
          const idx = pending.indexOf(entry);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error(`detach_ack timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        void writeFrame({ kind: "detach", sessionId }).catch((err) => {
          const idx = pending.indexOf(entry);
          if (idx >= 0) pending.splice(idx, 1);
          if (timer) clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
      return ack;
    },
    async sendCdpFrame(frame: CdpFrame): Promise<void> {
      await writeFrame(frame);
    },
    setFrameHandler(handler: ((frame: DriverFrame) => void) | null): void {
      frameHandler = handler;
    },
    subscribeFrames(listener: (frame: DriverFrame) => void): () => void {
      frameSubscribers.add(listener);
      return () => frameSubscribers.delete(listener);
    },
    setCloseHandler(handler: (() => void) | null): void {
      closeHandler = handler;
    },
    async close(): Promise<void> {
      writer?.close();
      socket?.destroy();
      connected = false;
      rejectAll(new Error("Driver client closed"));
    },
  };
}

function toCdpPayload(frame: CdpResultFrame | CdpErrorFrame | CdpEventFrame): string {
  switch (frame.kind) {
    case "cdp_result":
      return JSON.stringify({ id: frame.id, result: frame.result, sessionId: frame.sessionId });
    case "cdp_error":
      return JSON.stringify({ id: frame.id, error: frame.error, sessionId: frame.sessionId });
    case "cdp_event":
      return JSON.stringify({
        method: frame.method,
        params: frame.params,
        sessionId: frame.sessionId,
        eventId: frame.eventId,
      });
  }
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

export function wireLoopbackWebSocketBridge(
  options: LoopbackWebSocketBridgeOptions,
  server: LoopbackServerLike,
  wss: LoopbackWebSocketServerLike,
): { readonly close: () => Promise<void> } {
  let activeSocket: LoopbackWebSocketPeer | null = null;
  let detached = false;
  let pendingDetach: Promise<void> | null = null;

  // Idempotent detach: unexpected peer-close and explicit close() both converge
  // here. Fire-and-forget was unsafe — a lost ack would leave the host in
  // `detaching_failed` and future attach attempts bounce as already_attached.
  // Retain a promise of the detach so awaitable callers can wait for it.
  function tearDownSession(): Promise<void> {
    if (detached) return pendingDetach ?? Promise.resolve();
    detached = true;
    pendingDetach = options.transport.detach(options.sessionId).then(
      () => undefined,
      () => undefined,
    );
    return pendingDetach;
  }

  // Subscribe (not setFrameHandler) so multiple bridges can share a single
  // DriverClient without clobbering each other. Each bridge filters by its
  // own sessionId; unsubscribe on close.
  const unsubscribeFrames = options.transport.subscribeFrames((frame: DriverFrame): void => {
    if (activeSocket === null || activeSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (frame.kind === "cdp_result" || frame.kind === "cdp_error" || frame.kind === "cdp_event") {
      if (frame.sessionId !== options.sessionId) return;
      activeSocket.send(toCdpPayload(frame));
    }
  });

  server.on("upgrade", (request, socket, head) => {
    if (!isAuthorized(request, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (activeSocket !== null && activeSocket.readyState === WebSocket.OPEN) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws: LoopbackWebSocketPeer) => {
      activeSocket = ws;
      ws.on("message", (raw: WebSocket.RawData) => {
        const payload = JSON.parse(String(raw)) as {
          readonly id: number;
          readonly method: string;
          readonly params?: unknown;
        };
        void options.transport.sendCdpFrame({
          kind: "cdp",
          sessionId: options.sessionId,
          id: payload.id,
          method: payload.method,
          params: payload.params ?? {},
        });
      });
      ws.on("close", () => {
        if (activeSocket === ws) {
          activeSocket = null;
        }
        // Peer went away without an explicit close() — release the host's
        // ownership lease so the next attach attempt doesn't bounce. Fire
        // the detach but don't wait (we're in an event callback).
        void tearDownSession();
      });
    });
  });

  return {
    async close(): Promise<void> {
      unsubscribeFrames();
      activeSocket?.close();
      activeSocket = null;
      // Await the detach completion so the caller knows ownership has
      // actually been released host-side before the close() promise settles.
      // Without this, a transient transport error could leave the host's
      // detach coordinator in `detaching_failed` state + the caller's
      // next attach bouncing as already_attached, with no surfaced error.
      await tearDownSession();
    },
  };
}

export async function createLoopbackWebSocketBridge(
  options: LoopbackWebSocketBridgeOptions,
): Promise<LoopbackWebSocketBridge> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const wiring = wireLoopbackWebSocketBridge(
    options,
    server,
    wss as unknown as LoopbackWebSocketServerLike,
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind loopback WebSocket bridge");
  }

  return {
    endpoint: `ws://127.0.0.1:${address.port}/${randomUUID()}`,
    async close(): Promise<void> {
      // Await wiring.close() so the host-side detach ack has landed before
      // the bridge's close() resolves. Without this, a fast recreate →
      // reattach race can hit `already_attached` because the host still
      // owns the session when the caller tries to re-attach.
      await wiring.close();
      await new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError?: Error) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}
