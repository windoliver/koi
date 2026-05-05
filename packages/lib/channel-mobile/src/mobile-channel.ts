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
  /**
   * Trust client-supplied `senderId`/`threadId` from inbound frames. Default
   * `false`: client metadata is dropped and replaced with the host-configured
   * `senderId`. Set `true` only when the transport itself authenticates the
   * client and binds it to a single trusted identity (e.g., reverse proxy
   * with mTLS or signed bearer token).
   */
  readonly trustClientIdentity?: boolean;
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
  const trustClient = config.trustClientIdentity === true;

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
            // Strict single-client: a second concurrent connection is REJECTED,
            // not allowed to preempt. This removes the entire class of cross-
            // client leak (the agent's reply for ws1 cannot be misrouted to ws2
            // because ws2 was never accepted). The host MUST front this adapter
            // with auth that prevents reconnect-as-different-identity.
            if (activeSocket !== undefined) {
              ws.close();
              return;
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
          senderId: trustClient ? (frame.senderId ?? defaultSenderId) : defaultSenderId,
          timestamp: Date.now(),
          ...(trustClient && frame.threadId !== undefined ? { threadId: frame.threadId } : {}),
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
