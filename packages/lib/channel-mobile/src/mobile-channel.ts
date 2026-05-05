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
   * Invoked for every outbound message issued while no client is connected,
   * AND for replies whose originating session has ended (see the session-epoch
   * binding below). The adapter itself does NOT buffer outbound; the host's
   * push pipeline owns durability and retry. If `pushNotifier` rejects, the
   * `send()` call itself rejects so the host can observe / retry the failure.
   * If `pushNotifier` is undefined and there is nowhere to deliver, `send()`
   * rejects with a `MobileNoDeliveryTargetError`.
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

export class MobileNoDeliveryTargetError extends Error {
  constructor() {
    super("No connected client and no pushNotifier configured");
    this.name = "MobileNoDeliveryTargetError";
  }
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
  // Session-epoch binding prevents cross-session reply leakage. The epoch
  // increments on every open AND every close, so any disconnect/reconnect
  // cycle (even with the same client) creates a new session boundary. The
  // last inbound captured the epoch in effect when it was dispatched; if the
  // current epoch has moved on by the time the agent's reply arrives at
  // `platformSend`, the originating session is gone and the reply MUST NOT
  // be routed to the now-active socket. It is forwarded to `pushNotifier`
  // (or rejected) instead.
  // let requires justification: monotonic counter for session boundaries
  let sessionEpoch = 0;
  // let requires justification: epoch captured at most-recent inbound dispatch
  let lastInboundEpoch = -1;

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
            sessionEpoch++;
          },
          message(_ws: SocketLike, data: string | Uint8Array) {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            lineHandler?.(text);
          },
          close(ws: SocketLike) {
            if (activeSocket === ws) {
              activeSocket = undefined;
              sessionEpoch++;
            }
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
      // Cross-session safety: deliver to the active socket ONLY if the
      // originating session is still alive. If the session epoch has advanced
      // since the last inbound (i.e., a disconnect happened), the reply is
      // for a recipient that is gone — route it to push, not to whatever
      // client happens to be connected now. If no inbound has ever dispatched
      // (lastInboundEpoch === -1), allow direct delivery (host-initiated
      // outbound to the current connection).
      const sessionStillAlive =
        activeSocket !== undefined &&
        (lastInboundEpoch === -1 || lastInboundEpoch === sessionEpoch);
      if (sessionStillAlive && activeSocket !== undefined) {
        activeSocket.send(JSON.stringify({ kind: "msg", ...message, timestamp: Date.now() }));
        return;
      }
      // No live recipient — push pipeline owns durability.
      if (config.pushNotifier === undefined) {
        throw new MobileNoDeliveryTargetError();
      }
      // Propagate notifier failure so the caller can retry / observe.
      await config.pushNotifier(message);
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
        // Capture the session epoch at dispatch time so that any reply
        // generated after a disconnect/reconnect is detected and rerouted.
        lastInboundEpoch = sessionEpoch;
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
