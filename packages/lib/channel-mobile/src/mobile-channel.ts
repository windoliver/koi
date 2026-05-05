import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ContentBlock,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";

/**
 * `ChannelAdapter` extended with an explicit unsolicited-send path.
 *
 * `send()` is strict: once any inbound has dispatched, an outbound that
 * carries no valid reply tag (no `replyToInbound`-stamped HMAC and no
 * matching ALS context) is routed to `pushNotifier` (or rejected). This
 * makes detached late replies fail closed instead of leaking to whichever
 * client is currently connected.
 *
 * `sendUnsolicited()` is the explicit escape hatch for genuinely host-
 * initiated messages (welcome banners, resume notifications) where the
 * host accepts that the message goes to whichever client is currently
 * connected. The trust trade is opted into per call site.
 */
export interface MobileChannelAdapter extends ChannelAdapter {
  readonly sendUnsolicited: (message: OutboundMessage) => Promise<void>;
}

/**
 * # Trust model — fail-closed by default
 *
 * `@koi/channel-mobile` is an **anonymous, single-socket** transport.
 * Cross-session reply leakage is prevented by a single rule: every outbound
 * after the first inbound MUST carry a valid correlation tag, otherwise
 * `send()` routes it to `pushNotifier` instead of the live socket.
 *
 * 1. **Strict single-client at the socket layer** — a second concurrent
 *    connection is rejected (not preempted); inbound frames from non-active
 *    sockets are dropped at `message()`. Eliminates the *concurrent* leak.
 *
 * 2. **HMAC-signed reply tag on the inbound** — every dispatched inbound
 *    carries `metadata.mobileSessionEpoch` + `metadata.mobileSessionMac`,
 *    signed with this adapter's private secret. `replyToInbound(inbound,
 *    message)` propagates the tag onto the outbound. The tag survives
 *    object cloning, queue serialization (with HMAC re-signing on the
 *    far side via the inbound copy), and any wrapper that preserves the
 *    metadata field. Forgery requires the per-instance secret.
 *
 * 3. **AsyncLocalStorage convenience tag** — handler-chain `send()` calls
 *    inherit the originating session epoch via ALS without code changes.
 *    Detached callbacks lose this context; for those, hosts must use
 *    `replyToInbound()` so the HMAC tag rides on the message itself.
 *
 * 4. **`send()` is fail-closed once any inbound has dispatched** — outbound
 *    with no valid HMAC tag AND no matching ALS context routes to
 *    `pushNotifier` (or rejects). Any code path that forgot to use
 *    `replyToInbound()` for a late reply gets pushed instead of leaked.
 *
 * 5. **`sendUnsolicited()` is the explicit unsolicited path** — hosts that
 *    genuinely want to address whichever client is currently connected
 *    (welcome banners, resume notifications) call this method, not `send()`.
 *    The trust trade is opted into per call site, never silently inferred.
 *
 * 6. **No in-process buffering** — outbound while disconnected is forwarded
 *    to `pushNotifier` (or `send()` rejects). The adapter never replays a
 *    backlog to a future client.
 *
 * `send()` BEFORE any inbound has happened is treated as host-initiated:
 * a host that issues outbound on a virgin channel necessarily knows the
 * only possible recipient is whoever is connected.
 */

export interface MobileChannelConfig {
  readonly port: number;
  readonly senderId?: string;
  /**
   * Invoked for every outbound message issued while no live recipient
   * exists (no client connected, OR a strict reply whose originating
   * session has ended). Failure propagates to the `send()` caller so the
   * host can observe / retry. If `pushNotifier` is undefined and there is
   * nowhere to deliver, `send()` rejects with `MobileNoDeliveryTargetError`.
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

// Tags travel through `metadata` on both InboundMessage and OutboundMessage
// so they survive cross-boundary wrappers, clones, and queue serialization.
// Forgery is prevented by HMAC: only the adapter that produced the inbound
// knows the secret needed to compute a valid MAC. Cross-instance honoring
// is also prevented because each instance has its own secret.
const EPOCH_KEY = "mobileSessionEpoch";
const MAC_KEY = "mobileSessionMac";
const UNSOLICITED_MAC_KEY = "mobileUnsolicitedMac";

/**
 * Build an `OutboundMessage` that explicitly replies to a given inbound.
 * The returned message carries the originating session epoch + an HMAC
 * tag derived from the inbound's own metadata. Because the tag is read
 * directly from the inbound's metadata (not a WeakMap), it survives any
 * persistence/clone/queue path that preserves the metadata field.
 */
export function replyToInbound(inbound: InboundMessage, message: OutboundMessage): OutboundMessage {
  const epoch = inbound.metadata?.[EPOCH_KEY];
  const mac = inbound.metadata?.[MAC_KEY];
  if (typeof epoch !== "number" || typeof mac !== "string") return message;
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      [EPOCH_KEY]: epoch,
      [MAC_KEY]: mac,
    },
  };
}

interface InboundFrame {
  readonly kind?: string;
  readonly content?: readonly ContentBlock[];
  readonly senderId?: string;
}

function extractAndVerifyEpoch(
  message: OutboundMessage,
  verify: (epoch: number, mac: string) => boolean,
): number | undefined {
  const meta = message.metadata;
  if (meta === undefined) return undefined;
  const epoch = meta[EPOCH_KEY];
  const mac = meta[MAC_KEY];
  if (typeof epoch !== "number" || typeof mac !== "string") return undefined;
  return verify(epoch, mac) ? epoch : undefined;
}

function stripInternalMetadata(message: OutboundMessage): OutboundMessage {
  if (message.metadata === undefined) return message;
  const { [EPOCH_KEY]: _e, [MAC_KEY]: _m, [UNSOLICITED_MAC_KEY]: _u, ...rest } = message.metadata;
  if (Object.keys(rest).length === 0) {
    const { metadata: _md, ...withoutMetadata } = message;
    return withoutMetadata;
  }
  return { ...message, metadata: rest };
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
  // Per-instance HMAC secret: tags from this adapter cannot be forged or
  // honored by another instance. The secret never leaves this closure.
  const instanceSecret = new Uint8Array(randomBytes(32));
  const sign = (epoch: number): string =>
    createHmac("sha256", instanceSecret).update(String(epoch)).digest("hex");
  const unsolicitedTag = createHmac("sha256", instanceSecret).update("unsolicited").digest("hex");
  const verify = (epoch: number, mac: string): boolean => {
    try {
      const expectedHex = sign(epoch);
      if (expectedHex.length !== mac.length) return false;
      const expected = new Uint8Array(Buffer.from(expectedHex, "hex"));
      const provided = new Uint8Array(Buffer.from(mac, "hex"));
      if (expected.length !== provided.length) return false;
      return timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  };
  const verifyUnsolicited = (mac: string): boolean => {
    try {
      if (mac.length !== unsolicitedTag.length) return false;
      const expected = new Uint8Array(Buffer.from(unsolicitedTag, "hex"));
      const provided = new Uint8Array(Buffer.from(mac, "hex"));
      if (expected.length !== provided.length) return false;
      return timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  };

  // let requires justification: socket and server lifecycle managed dynamically
  let server: ServerLike | undefined;
  let activeSocket: SocketLike | undefined;
  let lineHandler: ((line: string) => void) | undefined;
  // Monotonic counter that ticks on every open AND every close — any
  // disconnect/reconnect cycle (even with the same client) creates a new
  // session boundary that strict-mode correlation can detect.
  // let requires justification: monotonic counter for session boundaries
  let sessionEpoch = 0;
  // Tracks whether *any* inbound has dispatched on this adapter. Until the
  // first inbound, untagged sends are treated as host-initiated (no possible
  // cross-session recipient yet). After, they fail closed without a tag.
  // let requires justification: tracks first-inbound transition
  let lastInboundEpoch = -1;

  // ALS tags handler-chain sends with the originating session epoch (a
  // belt-and-suspenders signal alongside the metadata-borne HMAC tag).
  // Detached callbacks lose this context; for those, hosts must use
  // replyToInbound() so the HMAC tag rides on the message itself.
  const sessionContext = new AsyncLocalStorage<number>();

  const inner = createChannelAdapter<string>({
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
            // not allowed to preempt. Removes the cross-client misroute class.
            if (activeSocket !== undefined) {
              ws.close();
              return;
            }
            activeSocket = ws;
            sessionEpoch++;
          },
          message(ws: SocketLike, data: string | Uint8Array) {
            // Hard gate: the WS close handshake is asynchronous, so a
            // rejected (non-active) socket can race a `message` event in.
            if (ws !== activeSocket) {
              ws.close();
              return;
            }
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
      // Classify the outbound by what correlation signal (if any) it carries:
      //   1. HMAC-signed unsolicited tag — explicit `sendUnsolicited()` call;
      //      route to whichever client is currently connected.
      //   2. HMAC-signed reply tag — `replyToInbound()` survives wrappers and
      //      clones; only the originating session matches.
      //   3. AsyncLocalStorage tag — handler-chain convenience signal.
      //   4. No tag AND no inbound has ever dispatched — host-initiated on a
      //      virgin channel; route live (only one possible recipient).
      //   5. No tag AND at least one inbound has dispatched — FAIL CLOSED;
      //      route to pushNotifier (or reject) instead of silently leaking.
      const unsolicitedMac = message.metadata?.[UNSOLICITED_MAC_KEY];
      const isUnsolicited = typeof unsolicitedMac === "string" && verifyUnsolicited(unsolicitedMac);
      const epochFromMeta = extractAndVerifyEpoch(message, verify);
      const epochFromAls = sessionContext.getStore();
      const taggedEpoch = epochFromMeta ?? epochFromAls;
      // let requires justification: classification depends on signal presence
      let liveRecipient: boolean;
      if (isUnsolicited) {
        liveRecipient = activeSocket !== undefined;
      } else if (taggedEpoch !== undefined) {
        liveRecipient = taggedEpoch === sessionEpoch && activeSocket !== undefined;
      } else if (lastInboundEpoch === -1) {
        liveRecipient = activeSocket !== undefined;
      } else {
        liveRecipient = false;
      }
      // Strip our internal metadata fields before they cross the wire — the
      // remote client has no use for them.
      const wireMessage = stripInternalMetadata(message);
      if (liveRecipient && activeSocket !== undefined) {
        activeSocket.send(JSON.stringify({ kind: "msg", ...wireMessage, timestamp: Date.now() }));
        return;
      }
      if (config.pushNotifier === undefined) {
        throw new MobileNoDeliveryTargetError();
      }
      await config.pushNotifier(wireMessage);
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
        const inbound: InboundMessage = {
          content,
          senderId: trustClient ? (frame.senderId ?? defaultSenderId) : defaultSenderId,
          timestamp: Date.now(),
        };
        // The signed-metadata stamping happens below in the return clause.
        // Stamp the inbound with a signed tag so replyToInbound() can
        // propagate it onto outbound replies. Storing the tag in the
        // inbound's own metadata (rather than a WeakMap) ensures it
        // survives clone, persistence, and queue serialization — the tag
        // travels with the message itself.
        lastInboundEpoch = sessionEpoch;
        const signedInbound: InboundMessage = {
          ...inbound,
          metadata: {
            ...(inbound.metadata ?? {}),
            [EPOCH_KEY]: sessionEpoch,
            [MAC_KEY]: sign(sessionEpoch),
          },
        };
        return signedInbound;
      } catch {
        return null;
      }
    },
  });

  // Wrap onMessage so user handlers run inside an ALS context tagged with the
  // current sessionEpoch. Plain `send()` calls along the handler's normal
  // async chain inherit the tag without code changes.
  //
  // Wrap send() so that messages tagged via replyToInbound() carry their
  // session token through to platformSend even after channel-base clones
  // the message during renderBlocks (which would lose WeakMap identity).
  const wrapped: MobileChannelAdapter = {
    name: inner.name,
    capabilities: inner.capabilities,
    connect: inner.connect,
    disconnect: inner.disconnect,
    send: inner.send,
    onMessage: (handler: MessageHandler): (() => void) =>
      inner.onMessage(async (msg) => {
        // The inbound carries its session epoch in metadata (signed). Use
        // that as the ALS tag so handler-chain sends inherit it; falls
        // through to current sessionEpoch if metadata is absent.
        const metaEpoch = msg.metadata?.[EPOCH_KEY];
        const epoch = typeof metaEpoch === "number" ? metaEpoch : sessionEpoch;
        return sessionContext.run(epoch, () => handler(msg));
      }),
    sendUnsolicited: (message: OutboundMessage): Promise<void> =>
      inner.send({
        ...message,
        metadata: { ...(message.metadata ?? {}), [UNSOLICITED_MAC_KEY]: unsolicitedTag },
      }),
  };
  if (inner.sendStatus !== undefined) {
    const fn = inner.sendStatus;
    return { ...wrapped, sendStatus: (s: ChannelStatus) => fn(s) };
  }
  return wrapped;
}
