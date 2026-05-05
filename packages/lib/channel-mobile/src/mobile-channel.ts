import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";

export type MobileChannelAdapter = ChannelAdapter;

export interface MobileChannelConfig {
  readonly port: number;
  readonly senderId?: string;
  /**
   * Invoked for every outbound message issued while no client is connected.
   * Provides the host's escape hatch for offline delivery (APNs, FCM, etc.) —
   * the adapter itself does NOT buffer outbound messages, because it cannot
   * prove that the next client to connect is the same recipient and would
   * otherwise leak prior content across sessions.
   */
  readonly pushNotifier?: (message: OutboundMessage) => Promise<void>;
  /**
   * Trust client-supplied `senderId` from inbound frames. Default `false`:
   * client metadata is dropped and replaced with the host-configured
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
}

// `threads: false` deliberately. Threading would require a server-assigned,
// transport-bound thread id; without trusted client identity the adapter
// cannot uphold thread routing semantics and would silently collapse sessions.
const MOBILE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

interface ServerLike {
  readonly stop: (closeActiveConnections?: boolean) => void;
}

interface SocketLike {
  readonly send: (data: string) => unknown;
  readonly close: () => unknown;
}

export function createMobileChannel(config: MobileChannelConfig): MobileChannelAdapter {
  const defaultSenderId = config.senderId ?? "mobile-user";
  const trustClient = config.trustClientIdentity === true;

  // let requires justification: socket and server lifecycle managed dynamically
  let server: ServerLike | undefined;
  let activeSocket: SocketLike | undefined;
  let lineHandler: ((line: string) => void) | undefined;

  return createChannelAdapter<string>({
    name: "mobile",
    capabilities: MOBILE_CAPABILITIES,
    platformConnect: async () => {
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
            // not allowed to preempt. Removes the cross-client misroute class —
            // the agent's reply for ws1 cannot leak to ws2 because ws2 was never
            // accepted. Hosts that need multi-client must run multiple instances.
            if (activeSocket !== undefined) {
              ws.close();
              return;
            }
            activeSocket = ws;
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
      // No connected client: hand off to the host's push pipeline if configured.
      // The adapter intentionally does NOT buffer — buffered replays cannot
      // distinguish recipients and would leak content across sessions.
      if (config.pushNotifier !== undefined) {
        try {
          await config.pushNotifier(message);
        } catch {
          // push failure is non-fatal and not retried — the host pipeline is
          // expected to provide its own retry/durability semantics.
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
        };
      } catch {
        return null;
      }
    },
  });
}
