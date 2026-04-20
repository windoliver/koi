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
   * Send a `detach` frame for the given session. The host tears down the
   * debugger attachment; driver receives `detach_ack` (routed separately).
   * Resolves immediately after the frame is written — it does not wait for
   * the ack (callers that need it should use setFrameHandler or compose a
   * waitFor themselves).
   */
  readonly detach: (sessionId: string) => Promise<void>;
  readonly sendCdpFrame: (frame: CdpFrame) => Promise<void>;
  readonly setFrameHandler: (handler: ((frame: DriverFrame) => void) | null) => void;
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
  readonly transport: Pick<DriverClient, "sendCdpFrame" | "setFrameHandler" | "detach">;
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
      const waiter = waitFor((candidate): candidate is TabsFrame => candidate.kind === "tabs");
      await writeFrame({ kind: "list_tabs" });
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
    async detach(sessionId: string): Promise<void> {
      await writeFrame({ kind: "detach", sessionId });
    },
    async sendCdpFrame(frame: CdpFrame): Promise<void> {
      await writeFrame(frame);
    },
    setFrameHandler(handler: ((frame: DriverFrame) => void) | null): void {
      frameHandler = handler;
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
): { readonly close: () => void } {
  let activeSocket: LoopbackWebSocketPeer | null = null;

  options.transport.setFrameHandler((frame: DriverFrame): void => {
    if (activeSocket === null || activeSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (frame.kind === "cdp_result" || frame.kind === "cdp_error" || frame.kind === "cdp_event") {
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
      });
    });
  });

  return {
    close(): void {
      options.transport.setFrameHandler(null);
      activeSocket?.close();
      activeSocket = null;
      // Send detach to the host so it tears down the debugger attachment and
      // clears ownership. Without this, the host keeps the tab marked owned
      // until the driver connection drops — which bounces `already_attached`
      // on the next attach attempt.
      void options.transport.detach(options.sessionId).catch(() => {});
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
      wiring.close();
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
