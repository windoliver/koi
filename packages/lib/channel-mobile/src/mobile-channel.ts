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
 * 7. **No virgin-channel escape hatch** — even on a fresh adapter with no
 *    prior inbound, `send()` without a valid tag fails closed. This stops a
 *    delayed reply or replayed outbound (after restart, after instance
 *    failover) from live-delivering to whichever client happens to be
 *    connected on the new instance. Hosts that need to address the current
 *    client unconditionally must use `sendUnsolicited()`.
 */

/**
 * Recipient-routing context handed to `pushNotifier`. The adapter computes
 * what it knows from the originating inbound (when the outbound carries a
 * valid reply tag); the host's notifier maps it to a real device/user.
 */
export interface MobilePushContext {
  /**
   * The originating inbound's `senderId` if and only if the outbound
   * carries a verifiable reply correlation (HMAC tag from `replyToInbound`,
   * or matching ALS context). `undefined` for unsolicited / untagged sends —
   * the adapter has no recipient to route to in that case.
   *
   * In `trustClientIdentity: true` mode, this is the client-authenticated
   * identity. In default untrusted mode, this is the host-configured
   * placeholder `senderId` from config (the same string for every session)
   * — useful only when the host runs a single trusted recipient identity,
   * otherwise insufficient and the host MUST refuse to push.
   */
  readonly originatingSenderId?: string;
  /** Originating thread, if any (only populated when trustClientIdentity is on). */
  readonly originatingThreadId?: string;
}

export interface MobileChannelConfig {
  readonly port: number;
  readonly senderId?: string;
  /**
   * Invoked for every outbound message issued while no live recipient
   * exists (no client connected, OR a strict reply whose originating
   * session has ended). The second argument is the recipient-routing
   * context the adapter could derive from the originating inbound — see
   * `MobilePushContext`. The host's notifier is responsible for translating
   * that context into a real device/user push token; if it cannot, it MUST
   * reject so `send()` surfaces the failure.
   *
   * Failure propagates to the `send()` caller so the host can observe /
   * retry. If `pushNotifier` is undefined and there is nowhere to deliver,
   * `send()` rejects with `MobileNoDeliveryTargetError`.
   */
  readonly pushNotifier?: (message: OutboundMessage, context: MobilePushContext) => Promise<void>;
  /**
   * Trust client-supplied `senderId` from inbound frames. Default `false`:
   * client metadata is dropped and replaced with the host-configured
   * `senderId`. Set `true` only when the transport itself authenticates the
   * client and binds it to a single trusted identity (e.g., reverse proxy
   * with mTLS or signed bearer token).
   */
  readonly trustClientIdentity?: boolean;
  /**
   * Server-side authentication and identity binding. Invoked on every
   * WebSocket upgrade BEFORE the socket is assigned as the active session.
   * Return a unique recipient identity string to accept the connection;
   * return `null` to reject (the socket is closed before any frame is
   * dispatched). The returned identity replaces the host-configured
   * `senderId` for inbound frames from this socket and is the recipient
   * key handed to `pushNotifier` via `MobilePushContext.originatingSenderId`.
   *
   * REQUIRED when `pushNotifier` is configured AND `trustClientIdentity`
   * is left at default `false`: without it, every disconnected reply would
   * carry the same shared placeholder and could be misrouted across users.
   * `createMobileChannel()` throws at construction time if this invariant
   * is violated.
   */
  readonly authenticate?: (req: Request) => Promise<string | null> | string | null;
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
const ORIGIN_SENDER_KEY = "mobileOriginatingSenderId";
const ORIGIN_THREAD_KEY = "mobileOriginatingThreadId";

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
  const originSender = inbound.metadata?.[ORIGIN_SENDER_KEY];
  const originThread = inbound.metadata?.[ORIGIN_THREAD_KEY];
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      [EPOCH_KEY]: epoch,
      [MAC_KEY]: mac,
      ...(typeof originSender === "string" ? { [ORIGIN_SENDER_KEY]: originSender } : {}),
      ...(typeof originThread === "string" ? { [ORIGIN_THREAD_KEY]: originThread } : {}),
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
  const {
    [EPOCH_KEY]: _e,
    [MAC_KEY]: _m,
    [UNSOLICITED_MAC_KEY]: _u,
    [ORIGIN_SENDER_KEY]: _os,
    [ORIGIN_THREAD_KEY]: _ot,
    ...rest
  } = message.metadata;
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
  // Construction-time guard against ambiguous push routing. If a push
  // notifier is wired but the adapter has no way to derive a unique
  // per-recipient identity (no client-trust, no server auth hook), every
  // pushed reply would carry the same shared placeholder senderId and
  // could be misrouted across users. Refuse to construct rather than
  // ship a silent footgun.
  if (
    config.pushNotifier !== undefined &&
    config.trustClientIdentity !== true &&
    config.authenticate === undefined
  ) {
    throw new Error(
      "@koi/channel-mobile: pushNotifier requires either trustClientIdentity:true (transport-authenticated client identity) or an authenticate() handshake (server-authenticated identity). Without one, the adapter cannot supply a unique recipient key and could misroute delayed replies across users.",
    );
  }
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
  // Identity bound to activeSocket by the authenticate() handshake. When
  // set, this overrides defaultSenderId for inbound frames from this socket
  // and is the recipient key passed to pushNotifier.
  // let requires justification: per-socket identity reset on close
  let activeIdentity: string | undefined;
  let lineHandler: ((line: string) => void) | undefined;
  // Monotonic counter that ticks on every open AND every close — any
  // disconnect/reconnect cycle (even with the same client) creates a new
  // session boundary that strict-mode correlation can detect.
  // let requires justification: monotonic counter for session boundaries
  let sessionEpoch = 0;

  // ALS tags handler-chain sends with the originating session epoch (a
  // belt-and-suspenders signal alongside the metadata-borne HMAC tag) plus
  // the originating sender/thread for push-context routing on detached-
  // recipient fallback. Detached callbacks lose this context; for those,
  // hosts must use replyToInbound() so the HMAC tag rides on the message.
  interface AlsCtx {
    readonly epoch: number;
    readonly senderId: string;
    readonly threadId?: string;
  }
  const sessionContext = new AsyncLocalStorage<AlsCtx>();

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
        fetch: async (
          req: Request,
          srv: { upgrade: (r: Request, opts?: { data?: unknown }) => boolean },
        ) => {
          // authenticate() runs BEFORE upgrade so an unauthenticated client
          // never gets a socket and therefore cannot occupy the single-
          // client slot. The verified identity rides through Bun's per-
          // connection `data` so `open()` knows which identity to bind.
          // let requires justification: identity computed conditionally
          let identity: string | undefined;
          if (config.authenticate !== undefined) {
            const result = await config.authenticate(req);
            if (result === null) {
              return new Response("unauthorized", { status: 401 });
            }
            identity = result;
          }
          if (srv.upgrade(req, { data: { identity } })) return undefined;
          return new Response("expected websocket", { status: 426 });
        },
        websocket: {
          open(ws: SocketLike & { readonly data?: { readonly identity?: string } }) {
            // Strict single-client: a second concurrent connection is REJECTED,
            // not allowed to preempt. Removes the cross-client misroute class.
            if (activeSocket !== undefined) {
              ws.close();
              return;
            }
            activeSocket = ws;
            activeIdentity = ws.data?.identity;
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
              activeIdentity = undefined;
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
      // Strict-by-default classification. Live delivery requires an explicit,
      // locally-verifiable correlation signal — there is NO virgin-channel
      // escape hatch, NO untagged-passthrough, and NO foreign-instance trust.
      // The four live-delivery paths:
      //   1. Unsolicited HMAC tag — `sendUnsolicited()` opt-in for genuinely
      //      host-initiated outbound (welcome banner, resume notification).
      //   2. Reply HMAC tag (this instance) — `replyToInbound()` correlation
      //      whose epoch matches the current session.
      //   3. AsyncLocalStorage tag (this instance) — handler-chain convenience
      //      whose epoch matches the current session.
      // Anything else — including a reply tag from another instance, a
      // replayed reply for a closed session, an untagged plain `send()` —
      // routes to `pushNotifier` (or rejects with `MobileNoDeliveryTargetError`).
      const unsolicitedMac = message.metadata?.[UNSOLICITED_MAC_KEY];
      const hasUnsolicitedField = unsolicitedMac !== undefined;
      const isUnsolicited = typeof unsolicitedMac === "string" && verifyUnsolicited(unsolicitedMac);
      const hasReplyField =
        message.metadata?.[EPOCH_KEY] !== undefined || message.metadata?.[MAC_KEY] !== undefined;
      const epochFromMeta = extractAndVerifyEpoch(message, verify);
      const alsCtx = sessionContext.getStore();
      // let requires justification: classification depends on signal presence
      let liveRecipient: boolean;
      if (hasUnsolicitedField) {
        // Present-but-invalid unsolicited tag → fail closed.
        liveRecipient = isUnsolicited && activeSocket !== undefined;
      } else if (hasReplyField) {
        // Present-but-invalid OR foreign reply tag → fail closed.
        liveRecipient =
          epochFromMeta !== undefined &&
          epochFromMeta === sessionEpoch &&
          activeSocket !== undefined;
      } else if (alsCtx !== undefined) {
        liveRecipient = alsCtx.epoch === sessionEpoch && activeSocket !== undefined;
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
      // Compute recipient-routing context from whatever signed signal the
      // outbound carries: prefer the reply tag's stamped origin (survives
      // detached callbacks), then fall back to ALS context (handler-chain).
      // For unsolicited or untagged fallbacks, the adapter has no recipient
      // to advise; the host's notifier must decide whether to drop or use
      // an out-of-band lookup.
      const ctx: MobilePushContext = (() => {
        const meta = message.metadata;
        const metaSender = meta?.[ORIGIN_SENDER_KEY];
        const metaThread = meta?.[ORIGIN_THREAD_KEY];
        if (epochFromMeta !== undefined && typeof metaSender === "string") {
          return {
            originatingSenderId: metaSender,
            ...(typeof metaThread === "string" ? { originatingThreadId: metaThread } : {}),
          };
        }
        if (alsCtx !== undefined) {
          return {
            originatingSenderId: alsCtx.senderId,
            ...(alsCtx.threadId !== undefined ? { originatingThreadId: alsCtx.threadId } : {}),
          };
        }
        return {};
      })();
      await config.pushNotifier(wireMessage, ctx);
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
        // Identity precedence: server-authenticated handshake wins over
        // client-supplied (even when trusted) wins over host placeholder.
        // The authenticate() identity is the strongest server-side signal.
        const senderId =
          activeIdentity ?? (trustClient ? (frame.senderId ?? defaultSenderId) : defaultSenderId);
        const inbound: InboundMessage = {
          content,
          senderId,
          timestamp: Date.now(),
        };
        // The signed-metadata stamping happens below in the return clause.
        // Stamp the inbound with a signed tag so replyToInbound() can
        // propagate it onto outbound replies. Storing the tag in the
        // inbound's own metadata (rather than a WeakMap) ensures it
        // survives clone, persistence, and queue serialization — the tag
        // travels with the message itself.
        const signedInbound: InboundMessage = {
          ...inbound,
          metadata: {
            ...(inbound.metadata ?? {}),
            [EPOCH_KEY]: sessionEpoch,
            [MAC_KEY]: sign(sessionEpoch),
            [ORIGIN_SENDER_KEY]: inbound.senderId,
            ...(inbound.threadId !== undefined ? { [ORIGIN_THREAD_KEY]: inbound.threadId } : {}),
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
        // The inbound carries its session epoch + originating sender in
        // metadata (signed). Use them as the ALS tag so handler-chain sends
        // inherit them and detached push fallback can still route.
        const metaEpoch = msg.metadata?.[EPOCH_KEY];
        const metaSender = msg.metadata?.[ORIGIN_SENDER_KEY];
        const ctx: AlsCtx = {
          epoch: typeof metaEpoch === "number" ? metaEpoch : sessionEpoch,
          senderId: typeof metaSender === "string" ? metaSender : msg.senderId,
          ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
        };
        return sessionContext.run(ctx, () => handler(msg));
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
