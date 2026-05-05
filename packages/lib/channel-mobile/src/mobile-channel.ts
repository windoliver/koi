import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";

/** ChannelAdapter extended with mobile-specific observability. */
export interface MobileChannelAdapter extends ChannelAdapter {
  readonly queueDepth: () => number;
}

export interface MobileChannelConfig {
  readonly port: number;
  readonly senderId?: string;
  readonly maxOfflineQueue?: number;
  readonly pushNotifier?: (message: OutboundMessage) => Promise<void>;
}

interface InboundFrame {
  readonly kind?: string;
  readonly content?: readonly ContentBlock[];
  readonly senderId?: string;
  readonly threadId?: string;
}

const MOBILE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

const DEFAULT_MAX_QUEUE = 100;

interface ServerLike {
  readonly stop: (closeActiveConnections?: boolean) => void;
}

interface SocketLike {
  readonly send: (data: string) => unknown;
  readonly close: () => unknown;
}

export function createMobileChannel(config: MobileChannelConfig): MobileChannelAdapter {
  const defaultSenderId = config.senderId ?? "mobile-user";
  const maxQueue = config.maxOfflineQueue ?? DEFAULT_MAX_QUEUE;

  // let requires justification: socket and server lifecycle managed dynamically
  let server: ServerLike | undefined;
  let activeSocket: SocketLike | undefined;
  let lineHandler: ((line: string) => void) | undefined;
  const offlineQueue: OutboundMessage[] = [];

  const flushQueue = (): void => {
    if (activeSocket === undefined) return;
    while (offlineQueue.length > 0) {
      const msg = offlineQueue.shift();
      if (msg === undefined) break;
      activeSocket.send(JSON.stringify({ kind: "msg", ...msg, timestamp: Date.now() }));
    }
  };

  const adapter = createChannelAdapter<string>({
    name: "mobile",
    capabilities: MOBILE_CAPABILITIES,
    platformConnect: async () => {
      // Lazy require Bun to keep type checking happy.
      const bunGlobal = (globalThis as { Bun?: { serve: (opts: unknown) => ServerLike } }).Bun;
      if (bunGlobal === undefined) {
        throw new Error("@koi/channel-mobile requires the Bun runtime");
      }
      server = bunGlobal.serve({
        port: config.port,
        fetch(req: Request, srv: { upgrade: (r: Request) => boolean }) {
          if (srv.upgrade(req)) return undefined;
          return new Response("expected websocket", { status: 426 });
        },
        websocket: {
          open(ws: SocketLike) {
            // Single-client semantics: previous socket evicted. The offline
            // queue is dropped whenever the active socket is replaced — the
            // adapter cannot prove the new client is the same recipient as
            // the queued backlog's intended audience, so flushing to the new
            // socket would risk delivering one client's private messages to
            // another. Queue is only valid for the *first* client to connect
            // after a period of disconnection.
            if (activeSocket !== undefined) {
              activeSocket.close();
              offlineQueue.length = 0;
            }
            activeSocket = ws;
            flushQueue();
          },
          message(_ws: SocketLike, data: string | Uint8Array) {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            lineHandler?.(text);
          },
          close(ws: SocketLike) {
            if (activeSocket === ws) activeSocket = undefined;
          },
        },
      });
    },
    platformDisconnect: async () => {
      activeSocket?.close();
      activeSocket = undefined;
      server?.stop(true);
      server = undefined;
    },
    platformSend: async (message: OutboundMessage) => {
      if (activeSocket !== undefined) {
        activeSocket.send(JSON.stringify({ kind: "msg", ...message, timestamp: Date.now() }));
        return;
      }
      if (offlineQueue.length >= maxQueue) offlineQueue.shift();
      offlineQueue.push(message);
      if (config.pushNotifier !== undefined) {
        try {
          await config.pushNotifier(message);
        } catch {
          // push failure is non-fatal — message stays queued
        }
      }
    },
    onPlatformEvent: (handler) => {
      lineHandler = handler;
      return () => {
        lineHandler = undefined;
      };
    },
    normalize: (line: string): InboundMessage | null => {
      try {
        const frame = JSON.parse(line) as InboundFrame;
        if (frame.kind !== "msg") return null;
        const content = frame.content ?? [];
        if (content.length === 0) return null;
        return {
          content,
          senderId: frame.senderId ?? defaultSenderId,
          timestamp: Date.now(),
          ...(frame.threadId !== undefined ? { threadId: frame.threadId } : {}),
        };
      } catch {
        return null;
      }
    },
  });

  return {
    ...adapter,
    queueDepth: () => offlineQueue.length,
  };
}
