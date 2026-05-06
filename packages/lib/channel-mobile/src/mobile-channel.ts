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
export interface MobileSendUnsolicitedOptions {
  /**
   * Explicit recipient identity for the offline push fallback path. Required
   * when the adapter has never authenticated a client (no `lastVerifiedIdentity`
   * to fall back on) and there is no live socket. When supplied, takes
   * precedence over any implicit derivation so the host can route a push to a
   * specific user even after a different user authenticated and disconnected.
   */
  readonly recipient?: string;
}

export interface MobileChannelAdapter extends ChannelAdapter {
  readonly sendUnsolicited: (
    message: OutboundMessage,
    opts?: MobileSendUnsolicitedOptions,
  ) => Promise<void>;
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
  /**
   * Set ONLY when this push is the ack-timeout fallback for a frame the
   * adapter already wrote to the live socket. The same id rode on the
   * wire payload as `deliveryId`. The host's pushNotifier MUST dedupe
   * on this id end-to-end (e.g., the client SDK records every received
   * `deliveryId` and discards a push carrying a duplicate) — otherwise
   * a client that received the live frame but whose ack was lost will
   * see the reply twice. Absent for unsolicited / no-live-attempt sends.
   */
  readonly deliveryId?: string;
}

export interface MobileChannelConfig {
  /**
   * TCP port to bind. MUST be a fixed, nonzero port the host has chosen.
   * Ephemeral binding (`port: 0`) is intentionally NOT supported — the
   * adapter does not expose the bound `Bun.serve` port back to callers,
   * so any client trying to connect to an OS-assigned port would have
   * no way to discover it. Hosts that want a free port should pick one
   * themselves (e.g. probe with `Bun.serve({ port: 0 })` then `stop()`)
   * before passing it here.
   */
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
   *
   * Dedup contract (REQUIRED when `ackTimeoutMs > 0`): if `context.deliveryId`
   * is set, this push is the ack-timeout fallback for a frame the adapter
   * already wrote to the live socket. The client may have received it
   * (and just lost the ack on a flaky link) — the host MUST dedupe on
   * `deliveryId` end-to-end so the user does not see the reply twice.
   * Typical pattern: the client SDK records every received `deliveryId`
   * and discards any subsequent push carrying a duplicate.
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
  /**
   * Optional 32-byte HMAC secret for reply correlation tags. When unset,
   * a per-process random secret is generated — sufficient for single-
   * instance, in-memory delivery, but means a `replyToInbound()` message
   * that is serialized to disk, queued externally, or replayed against a
   * NEW process instance will fail signature verification on the new
   * adapter and route to `pushNotifier` without recipient context.
   *
   * Hosts that need delayed replies to survive restart, failover, or
   * cross-instance replay MUST provide a stable secret (e.g. loaded from
   * a KMS/secret manager) shared by all adapter instances that should
   * accept each other's reply tags. Rotating the secret invalidates all
   * outstanding tags — by design.
   *
   * Required-with-pushNotifier: when `pushNotifier` is set, this MUST be
   * provided OR `unsafeAllowEphemeralSigningSecret` MUST be `true`. A
   * fresh per-process secret means any reply that survives this process
   * (queued, retried after restart, failed-over to a peer) cannot have
   * its tag verified on the new instance and loses the authenticated
   * recipient context push routing depends on. `createMobileChannel()`
   * throws at construction time if the invariant is violated.
   */
  readonly signingSecret?: Uint8Array;
  /**
   * Explicit acknowledgement that this deployment uses a per-process
   * random HMAC secret. Set `true` ONLY for single-instance deployments
   * with no restart/failover requirement, accepting that any reply tag
   * outliving the current process becomes unverifiable. Required when
   * `pushNotifier` is set AND `signingSecret` is unset — the explicit
   * opt-in keeps an unsafe default off the happy path.
   */
  readonly unsafeAllowEphemeralSigningSecret?: boolean;
  /**
   * Maximum milliseconds to wait for `authenticate()` before treating the
   * upgrade as failed. Without a bound, a hung IdP request would hold the
   * single-client reservation forever and reject every later client with
   * 409, taking the channel offline. On timeout the slot is released and
   * the upgrade returns 504. Default 10 s.
   */
  readonly authenticateTimeoutMs?: number;
  /**
   * Maximum milliseconds to wait for the client to ack a live-delivered
   * frame before treating the send as failed and falling through to
   * `pushNotifier`. The wire payload of every live send carries a
   * `deliveryId`; the client must respond with `{kind:"ack",deliveryId}`
   * within this window to confirm receipt. Without an ack, an unstable
   * radio link could drop the frame after `socket.send()` reported it
   * queued and the user would never receive the reply.
   *
   * Default `0` (disabled). Defaulting on would be a wire-protocol
   * breaking change for already-deployed clients that don't know how to
   * emit `{kind:"ack",deliveryId}`: every reply would sit for the full
   * window then either fall through to `pushNotifier` (duplicate
   * delivery if the live frame actually arrived) or throw
   * `MobileNoDeliveryTargetError`. Hosts MUST opt in by setting a
   * positive value, and SHOULD only do so after confirming all
   * connected client versions implement the ack frame.
   *
   * Required-with-pushNotifier: when `pushNotifier` is set, this MUST be
   * a positive number OR `unsafeAllowQueuedWriteAsDelivered` MUST be `true`.
   * Otherwise the adapter would treat a queued WebSocket write as
   * delivered and never fall back to push when the radio drops the frame
   * after `send()` reported it queued — a silent lost-reply path.
   * `createMobileChannel()` throws at construction time if the invariant
   * is violated.
   */
  readonly ackTimeoutMs?: number;
  /**
   * Explicit acknowledgement that this deployment treats a queued WebSocket
   * write as delivered (no application-level ack). Set `true` ONLY for
   * legacy clients that cannot emit `{kind:"ack",deliveryId}`, accepting
   * the risk that the radio could drop a frame after `socket.send()`
   * reported it queued and the user would never receive the reply.
   *
   * Required when `pushNotifier` is set AND `ackTimeoutMs` is 0/unset —
   * the explicit opt-in keeps an unsafe default off the happy path.
   */
  readonly unsafeAllowQueuedWriteAsDelivered?: boolean;
}

export class MobileNoDeliveryTargetError extends Error {
  constructor() {
    super("No connected client and no pushNotifier configured");
    this.name = "MobileNoDeliveryTargetError";
  }
}

/**
 * Thrown by `send()` when a live WebSocket write completes only partially
 * (some bytes reached the wire but not the full frame) — typically a
 * radio link closing under us or transport backpressure mid-write. The
 * adapter closes the corrupt socket to terminate the truncated frame
 * stream, but does NOT push-fall-back automatically: the client may
 * have already received and processed the truncated bytes (or could
 * receive them post-resume), and pushing the same logical message
 * again would deliver it twice.
 *
 * Recovery contract: the host SHOULD retry by calling `pushNotifier`
 * itself with the carried `deliveryId` — the client SDK already dedupes
 * on every `deliveryId` it has ever seen, so the retry is safe even if
 * the truncated bytes did reach the device. `bytesWritten` and
 * `bytesExpected` are surfaced for diagnostics.
 */
export class MobilePartialWriteError extends Error {
  readonly deliveryId: string;
  readonly bytesWritten: number;
  readonly bytesExpected: number;
  constructor(deliveryId: string, bytesWritten: number, bytesExpected: number) {
    super(
      `@koi/channel-mobile: partial WebSocket write (${String(bytesWritten)}/${String(bytesExpected)} bytes); socket closed to prevent duplicate delivery — host may safely retry via pushNotifier with deliveryId=${deliveryId}`,
    );
    this.name = "MobilePartialWriteError";
    this.deliveryId = deliveryId;
    this.bytesWritten = bytesWritten;
    this.bytesExpected = bytesExpected;
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
// Round-40 high: explicit recipient supplied by `sendUnsolicited(msg, {recipient})`.
// Travels on metadata so the platformSend offline path can route the push.
// Internal — host code uses the typed `MobileSendUnsolicitedOptions` API.
const UNSOLICITED_RECIPIENT_KEY = "mobileUnsolicitedRecipient";
const ORIGIN_SENDER_KEY = "mobileOriginatingSenderId";
const ORIGIN_THREAD_KEY = "mobileOriginatingThreadId";
// Per-session unguessable nonce (16 random bytes hex). Generated on every
// accepted socket open() and required to match for live delivery. Without
// this binding, a host-supplied stable signingSecret combined with the
// process-local epoch counter would let a stale replyToInbound() from a
// prior process be live-delivered into a later session for the same
// identity (epoch counts are reused across restarts; same identity passes
// the identity-match check). The nonce is regenerated per session and is
// not derivable from any cross-instance state, so cross-restart replays
// can only ever route to push.
const ORIGIN_NONCE_KEY = "mobileSessionNonce";

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
  const originNonce = inbound.metadata?.[ORIGIN_NONCE_KEY];
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      [EPOCH_KEY]: epoch,
      [MAC_KEY]: mac,
      ...(typeof originSender === "string" ? { [ORIGIN_SENDER_KEY]: originSender } : {}),
      ...(typeof originThread === "string" ? { [ORIGIN_THREAD_KEY]: originThread } : {}),
      ...(typeof originNonce === "string" ? { [ORIGIN_NONCE_KEY]: originNonce } : {}),
    },
  };
}

interface InboundFrame {
  readonly kind?: string;
  readonly content?: readonly unknown[];
  readonly senderId?: string;
  /** Set on `{kind:"ack", deliveryId}` frames the client sends to confirm receipt. */
  readonly deliveryId?: unknown;
}

/**
 * Maximum byte length of a single inbound WebSocket frame. Larger payloads
 * are dropped before JSON.parse to bound memory pressure from a hostile or
 * buggy client. 64 KiB is generous for text + small button payloads while
 * staying well below typical WebSocket fragment limits.
 */
const MAX_INBOUND_FRAME_BYTES = 64 * 1024;

/**
 * Upper bound on how long a passed-auth upgrade reservation can sit in
 * `pendingUpgrades` without an `open()` callback firing. If Bun accepted
 * the upgrade but the client died on the wire before the websocket opened,
 * nothing else releases the slot and the channel would be stuck at 409
 * forever. Five seconds is well above any realistic upgrade RTT and well
 * below any human-perceivable retry window.
 */
const UPGRADE_RESERVATION_TIMEOUT_MS = 5_000;

/** Default for {@link MobileChannelConfig.authenticateTimeoutMs}. */
const DEFAULT_AUTHENTICATE_TIMEOUT_MS = 10_000;

/** Default for {@link MobileChannelConfig.ackTimeoutMs}. */
// Off by default: opt-in to preserve wire compatibility with clients
// that don't know how to send `{kind:"ack",deliveryId}` frames.
const DEFAULT_ACK_TIMEOUT_MS = 0;

/** Sentinel for the auth race; using a unique symbol avoids collision with any user value. */
const AUTH_TIMEOUT_SENTINEL: unique symbol = Symbol("authenticate-timeout");

/** Sentinel that promotes an ack-timeout rejection into the push fallback path. */
const ACK_TIMEOUT_SENTINEL: unique symbol = Symbol("ack-timeout");

/**
 * Strict ContentBlock validator. Returns the input narrowed to ContentBlock
 * if every required field is present and well-typed; returns null otherwise.
 * Refusing malformed blocks at the trust boundary stops bad client input
 * from being smuggled into downstream handlers as `ContentBlock[]`.
 */
function validateContentBlock(value: unknown): ContentBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "text":
      return typeof v.text === "string" ? (value as ContentBlock) : null;
    case "file":
      return typeof v.url === "string" &&
        typeof v.mimeType === "string" &&
        (v.name === undefined || typeof v.name === "string")
        ? (value as ContentBlock)
        : null;
    case "image":
      return typeof v.url === "string" && (v.alt === undefined || typeof v.alt === "string")
        ? (value as ContentBlock)
        : null;
    case "button":
      return typeof v.label === "string" && typeof v.action === "string"
        ? (value as ContentBlock)
        : null;
    case "custom":
      return typeof v.type === "string" ? (value as ContentBlock) : null;
    default:
      return null;
  }
}

function validateContentBlocks(value: readonly unknown[]): readonly ContentBlock[] | null {
  const out: ContentBlock[] = [];
  for (const item of value) {
    const valid = validateContentBlock(item);
    if (valid === null) return null;
    out.push(valid);
  }
  return out;
}

interface VerifiedReplyTag {
  readonly epoch: number;
  readonly senderId: string;
  readonly threadId: string;
  readonly nonce: string;
}

function extractAndVerifyReply(
  message: OutboundMessage,
  verify: (
    epoch: number,
    nonce: string,
    senderId: string,
    threadId: string,
    mac: string,
  ) => boolean,
): VerifiedReplyTag | undefined {
  const meta = message.metadata;
  if (meta === undefined) return undefined;
  const epoch = meta[EPOCH_KEY];
  const mac = meta[MAC_KEY];
  if (typeof epoch !== "number" || typeof mac !== "string") return undefined;
  // Recipient fields are part of the signed payload. Default to "" when
  // absent so verification against the canonical empty-string signature
  // works (an inbound that genuinely had no threadId).
  const senderRaw = meta[ORIGIN_SENDER_KEY];
  const threadRaw = meta[ORIGIN_THREAD_KEY];
  const nonceRaw = meta[ORIGIN_NONCE_KEY];
  const senderId = typeof senderRaw === "string" ? senderRaw : "";
  const threadId = typeof threadRaw === "string" ? threadRaw : "";
  const nonce = typeof nonceRaw === "string" ? nonceRaw : "";
  return verify(epoch, nonce, senderId, threadId, mac)
    ? { epoch, senderId, threadId, nonce }
    : undefined;
}

function stripInternalMetadata(message: OutboundMessage): OutboundMessage {
  if (message.metadata === undefined) return message;
  const {
    [EPOCH_KEY]: _e,
    [MAC_KEY]: _m,
    [UNSOLICITED_MAC_KEY]: _u,
    [UNSOLICITED_RECIPIENT_KEY]: _ur,
    [ORIGIN_SENDER_KEY]: _os,
    [ORIGIN_THREAD_KEY]: _ot,
    [ORIGIN_NONCE_KEY]: _on,
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
  // Bun's WebSocket.send returns number bytes written (>= 0), -1 if closed,
  // or a partial-write count under backpressure. Anything <= 0 must be
  // treated as a delivery failure so the message can fall through to push.
  readonly send: (data: string) => number;
  readonly close: () => unknown;
}

export function createMobileChannel(config: MobileChannelConfig): MobileChannelAdapter {
  // Reject ephemeral port binding at construction. The adapter never
  // exposes the OS-assigned port back to callers, so a typo (or a
  // copy-pasted `port: 0` from a snippet) would silently bind an
  // unreachable random port while the service appeared to start
  // successfully. Fail closed so the misconfiguration is loud.
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(
      "@koi/channel-mobile: port must be a fixed integer in (0, 65535]. Ephemeral binding (port:0) is not supported because the adapter does not expose the bound port; pick a free port yourself before passing it here.",
    );
  }
  const defaultSenderId = config.senderId ?? "mobile-user";
  const trustClient = config.trustClientIdentity === true;
  // Construction-time guard: pushNotifier ALWAYS requires the server-side
  // authenticate() handshake. trustClientIdentity alone is not sufficient
  // because a plain WebSocket client could spoof another user's senderId
  // in the inbound frame and cause delayed replies to be routed to that
  // victim. authenticate() is the only source of an identity verified
  // BEFORE the socket is granted the active session and BEFORE inbound
  // frames are dispatched, so it is also the only source the adapter
  // promotes into `MobilePushContext.originatingSenderId`.
  if (config.pushNotifier !== undefined && config.authenticate === undefined) {
    throw new Error(
      "@koi/channel-mobile: pushNotifier requires an authenticate() handshake to bind a server-verified recipient identity. trustClientIdentity is not sufficient — a client could spoof another user's senderId and misroute delayed replies. Provide authenticate(req) to derive the identity from a verified handshake (mTLS, JWT, signed bearer token, etc.).",
    );
  }
  // pushNotifier-coupled safety guards. Both reject silent default-path
  // delivery loss / unverifiable late replies — the host must either
  // configure the safe option or explicitly opt into the lossy mode.
  if (
    config.pushNotifier !== undefined &&
    !(typeof config.ackTimeoutMs === "number" && config.ackTimeoutMs > 0) &&
    config.unsafeAllowQueuedWriteAsDelivered !== true
  ) {
    throw new Error(
      "@koi/channel-mobile: pushNotifier requires either a positive ackTimeoutMs (so live sends only succeed after the client acks the deliveryId) or an explicit unsafeAllowQueuedWriteAsDelivered:true opt-in. Without one of these, the adapter would treat a queued WebSocket write as delivered and never fall back to push when the radio drops the frame.",
    );
  }
  if (
    config.pushNotifier !== undefined &&
    config.signingSecret === undefined &&
    config.unsafeAllowEphemeralSigningSecret !== true
  ) {
    throw new Error(
      "@koi/channel-mobile: pushNotifier requires either a stable signingSecret (so reply tags survive restart/failover/cross-instance replay) or an explicit unsafeAllowEphemeralSigningSecret:true opt-in for single-instance deployments. Without one of these, any delayed reply that outlives the current process loses its authenticated recipient context.",
    );
  }
  // Per-instance HMAC secret: tags from this adapter cannot be forged or
  // honored by another instance. The secret never leaves this closure.
  // Use the host-supplied stable secret when present (so reply tags
  // survive restart/failover/cross-instance replay), otherwise fall back
  // to a per-process random secret for single-instance use.
  if (config.signingSecret !== undefined && config.signingSecret.byteLength < 32) {
    throw new Error("@koi/channel-mobile: signingSecret must be at least 32 bytes");
  }
  const instanceSecret =
    config.signingSecret !== undefined
      ? new Uint8Array(config.signingSecret)
      : new Uint8Array(randomBytes(32));
  // The signed payload binds the session epoch AND the recipient context
  // (originating senderId + threadId) together. Without this binding, a
  // wrapper / queue / middleware that copies a valid (epoch, mac) pair onto
  // a message with a mutated originatingSenderId could misroute the push
  // to the wrong device after the session closed. The HMAC payload is a
  // length-prefixed, NUL-delimited tuple so distinct field combinations
  // cannot collide via reordering or boundary ambiguity.
  const canonicalize = (epoch: number, nonce: string, senderId: string, threadId: string): string =>
    `${String(epoch)} ${String(nonce.length)}:${nonce} ${String(senderId.length)}:${senderId} ${String(threadId.length)}:${threadId}`;
  const sign = (epoch: number, nonce: string, senderId: string, threadId: string): string =>
    createHmac("sha256", instanceSecret)
      .update(canonicalize(epoch, nonce, senderId, threadId))
      .digest("hex");
  const unsolicitedTag = createHmac("sha256", instanceSecret).update("unsolicited").digest("hex");
  const verify = (
    epoch: number,
    nonce: string,
    senderId: string,
    threadId: string,
    mac: string,
  ): boolean => {
    try {
      const expectedHex = sign(epoch, nonce, senderId, threadId);
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
  // Set true by prePlatformDisconnect to short-circuit ack waiting on
  // any send that hasn't yet started executing when disconnect runs.
  // Without this flag, an in-flight call to channel-base's send() that
  // hasn't reached platformSend yet would still arm a 60-second ack
  // wait after disconnect already cleared the original pendingAcks
  // map, stalling the chain drain.
  // let requires justification: shutdown gate flipped by lifecycle
  let shuttingDown = false;
  // Identity bound to activeSocket by the authenticate() handshake. When
  // set, this overrides defaultSenderId for inbound frames from this socket
  // and is the recipient key passed to pushNotifier.
  // let requires justification: per-socket identity reset on close
  let activeIdentity: string | undefined;
  let lineHandler: ((line: string) => void) | undefined;
  // channel-base calls platformConnect() BEFORE it registers the inbound
  // handler via onPlatformEvent(). Without buffering, a client that
  // connects + sends in that startup window would silently lose its first
  // frame. We hold up to a small bounded backlog of pending lines and
  // drain them as soon as the handler is installed.
  // let requires justification: bounded startup buffer
  let pendingLines: string[] = [];
  const MAX_PENDING_LINES = 32;
  // Tracks upgrade requests that have passed the single-client gate but
  // not yet reached websocket.open(). Concurrent upgrades that observe
  // a non-zero count are rejected before authenticate() runs, so a
  // handshake burst cannot force the host's expensive auth path on
  // every doomed second-client.
  // let requires justification: in-flight slot counter
  let pendingUpgrades = 0;
  // Monotonic counter that ticks on every open AND every close — any
  // disconnect/reconnect cycle (even with the same client) creates a new
  // session boundary that strict-mode correlation can detect.
  // let requires justification: monotonic counter for session boundaries
  let sessionEpoch = 0;
  // Connect-cycle generation. Bumped in platformDisconnect so any auth/
  // upgrade work captured while the prior connect was live is fenced
  // from claiming activeSocket on a torn-down or post-reconnect adapter.
  // Without this fence, a slow authenticate() that resolves AFTER
  // disconnect() returned could still reach srv.upgrade()/open() and
  // strand the single-client slot or accept inbound frames into a
  // lifecycle the host believes is gone.
  // let requires justification: monotonic counter for connect cycles
  let connectGen = 0;
  // Pending application-level acks for live-delivered frames. The wire
  // payload of every live send carries a `deliveryId` and the client
  // must respond with `{kind:"ack", deliveryId}` within `ackTimeoutMs`.
  // On ack: resolve the send. On timeout / disconnect: route to push
  // notifier (or reject) so a radio-drop after `socket.send()` queued
  // the frame doesn't silently lose the message.
  // let requires justification: per-send pending state
  const pendingAcks = new Map<
    string,
    {
      readonly resolve: () => void;
      readonly reject: (err: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const ackTimeoutMs = config.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  // Per-session unguessable nonce. Refreshed on every accepted socket
  // open() so that a stale tag from a prior session/process — even one
  // signed with a stable cross-instance signingSecret and the same epoch
  // value — cannot satisfy the live-delivery check. Empty string when no
  // session is active; the sentinel never matches a real (16-byte hex)
  // nonce, so off-session replies always fall through to push.
  // let requires justification: refreshed per session
  let sessionNonce = "";

  // ALS tags handler-chain sends with the originating session epoch (a
  // belt-and-suspenders signal alongside the metadata-borne HMAC tag) plus
  // the originating sender/thread for push-context routing on detached-
  // recipient fallback. Detached callbacks lose this context; for those,
  // hosts must use replyToInbound() so the HMAC tag rides on the message.
  interface AlsCtx {
    readonly epoch: number;
    readonly nonce: string;
    readonly senderId: string;
    readonly threadId?: string;
  }
  const sessionContext = new AsyncLocalStorage<AlsCtx>();

  // Recipient context comes ONLY from authenticated material:
  //   - VerifiedReplyTag if HMAC matches the (epoch, sender, thread)
  //     tuple actually present in metadata. Mutated origin fields break
  //     the signature → no context derived.
  //   - ALS context otherwise (handler-chain inherited).
  // Empty `{}` means the host has no authenticated routing key — its
  // pushNotifier MUST refuse if it cannot identify a recipient.
  const derivePushContext = (
    verifiedReply: VerifiedReplyTag | undefined,
    alsCtx: AlsCtx | undefined,
    deliveryId?: string,
    // Identity captured at the moment the live frame was written to
    // the socket. ONLY pass this for ack-timeout fallback after a
    // successful live write — never for plain push (no live attempt)
    // or for sends that didn't reach the wire. Reading the mutable
    // global activeIdentity here would let user A's late fallback
    // re-route to user B if B reconnected in between.
    capturedIdentityAtLiveSend?: string,
    // Round-40/41 high: explicit caller-supplied recipient for offline
    // `sendUnsolicited` overrides every implicit derivation. There is NO
    // implicit "last user" fallback — round-41 review correctly flagged
    // a global `lastVerifiedIdentity` as a wrong-user delivery vector
    // under reconnects (push to whoever connected last, not the intended
    // recipient). Hosts that need offline targeting MUST pass an
    // explicit `recipient`; otherwise the empty context surfaces and
    // `pushNotifier` is responsible for refusing to deliver.
    explicitRecipient?: string,
  ): MobilePushContext => {
    const idPart = deliveryId !== undefined ? { deliveryId } : {};
    if (explicitRecipient !== undefined && explicitRecipient.length > 0) {
      return { originatingSenderId: explicitRecipient, ...idPart };
    }
    if (verifiedReply !== undefined) {
      return {
        originatingSenderId: verifiedReply.senderId,
        ...(verifiedReply.threadId.length > 0
          ? { originatingThreadId: verifiedReply.threadId }
          : {}),
        ...idPart,
      };
    }
    if (alsCtx !== undefined) {
      return {
        originatingSenderId: alsCtx.senderId,
        ...(alsCtx.threadId !== undefined ? { originatingThreadId: alsCtx.threadId } : {}),
        ...idPart,
      };
    }
    if (capturedIdentityAtLiveSend !== undefined && capturedIdentityAtLiveSend.length > 0) {
      // Unsolicited ack-timeout fallback: the identity was bound to
      // the SPECIFIC delivery attempt (captured at live-write time),
      // so this push targets exactly the user the message was sent to.
      return { originatingSenderId: capturedIdentityAtLiveSend, ...idPart };
    }
    return idPart;
  };

  const inner = createChannelAdapter<string>({
    name: "mobile",
    capabilities: MOBILE_CAPABILITIES,
    platformConnect: async () => {
      shuttingDown = false;
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
          // Reject non-WebSocket traffic BEFORE touching the upgrade slot
          // or invoking authenticate(). A plain HTTP request (health check,
          // browser probe, attacker spam) must not consume the single-
          // client reservation or trigger the host's potentially expensive
          // auth path — otherwise routine HTTP noise becomes a denial-of-
          // service vector against the only connection slot. Per RFC 6455
          // §4.1, a valid client upgrade carries `Upgrade: websocket` (case-
          // insensitive) AND `Connection` containing "Upgrade".
          const upgradeHdr = req.headers.get("upgrade");
          const connectionHdr = req.headers.get("connection");
          const looksLikeUpgrade =
            upgradeHdr !== null &&
            upgradeHdr.toLowerCase() === "websocket" &&
            connectionHdr !== null &&
            connectionHdr
              .toLowerCase()
              .split(",")
              .some((p) => p.trim() === "upgrade");
          if (!looksLikeUpgrade) {
            return new Response("expected websocket upgrade", { status: 426 });
          }
          // Capture the connect-cycle generation at the entry to this
          // upgrade. If platformDisconnect bumps connectGen while
          // authenticate() is in flight, we must NOT proceed to
          // srv.upgrade() — the adapter the host believes is gone would
          // otherwise resurrect a session on a torn-down lifecycle.
          const genAtFetch = connectGen;
          // Single-client short-circuit: reserve the slot BEFORE running
          // authenticate() — and BEFORE awaiting any other in-flight
          // handshake. Without the pendingUpgrades counter, concurrent
          // requests that arrive before the first open() would all see an
          // empty activeSocket slot and all execute the host's potentially
          // expensive auth path, turning the adapter into an auth-
          // amplification point under handshake bursts.
          if (activeSocket !== undefined || pendingUpgrades > 0) {
            return new Response("conflict: another client connected", { status: 409 });
          }
          pendingUpgrades++;
          // The reservation slot has two distinct phases that need different
          // failure handling, so we keep a single release flag but DO NOT
          // arm the safety timer until phase 2:
          //   Phase 1 (auth in flight): the slot is held while authenticate()
          //     runs. A slow IdP must NOT release the slot — that would
          //     allow concurrent clients to enter authenticate() in parallel,
          //     defeating the auth-amplification guard. So the timer is
          //     deliberately NOT armed during this phase; explicit failure
          //     paths (auth reject, auth throw, upgrade fail) release
          //     synchronously.
          //   Phase 2 (upgrade succeeded, awaiting open()): only here can
          //     the connection silently die in a way no callback observes
          //     (TCP RST in the upgrade-to-open gap). The bounded timer is
          //     armed AFTER srv.upgrade() returns true to release the slot
          //     if open() never fires.
          // let requires justification: tracks whether decrement happened
          let upgradeReleased = false;
          const releaseUpgrade = (): void => {
            if (upgradeReleased) return;
            upgradeReleased = true;
            if (pendingUpgrades > 0) pendingUpgrades--;
          };
          // authenticate() runs BEFORE upgrade so an unauthenticated
          // client never gets a socket and cannot occupy the single slot.
          // The verified identity rides through Bun's per-connection
          // `data` so `open()` knows which identity to bind. We only
          // decrement pendingUpgrades on failure paths — open() owns the
          // decrement on success so the slot stays reserved across the
          // upgrade-to-open async gap.
          // let requires justification: identity computed conditionally
          let identity: string | undefined;
          try {
            if (config.authenticate !== undefined) {
              // Bounded auth — without this, a hung IdP request holds
              // pendingUpgrades=1 forever and bricks the channel until
              // process restart. The timeout races authenticate() against
              // a bounded timer; on expiry the slot releases and we
              // surface 504 to the client. The original auth promise is
              // not cancellable from this layer, so it may keep running
              // in the background — that is the host's problem to bound
              // in their authenticate() implementation if they care.
              const authTimeoutMs = config.authenticateTimeoutMs ?? DEFAULT_AUTHENTICATE_TIMEOUT_MS;
              // let requires justification: timer ref captured for cleanup
              let authTimer: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<typeof AUTH_TIMEOUT_SENTINEL>((resolve) => {
                authTimer = setTimeout(() => resolve(AUTH_TIMEOUT_SENTINEL), authTimeoutMs);
              });
              const authPromise = Promise.resolve(config.authenticate(req));
              const raced = await Promise.race([authPromise, timeoutPromise]);
              if (authTimer !== undefined) clearTimeout(authTimer);
              if (raced === AUTH_TIMEOUT_SENTINEL) {
                releaseUpgrade();
                return new Response("authenticate timeout", { status: 504 });
              }
              const result = raced;
              // Reject null AND empty/whitespace-only identities. Treating
              // an empty string as a valid recipient would collapse every
              // such session into the same identity bucket — defeating
              // the isolation guarantee that live-delivery and push routing
              // depend on.
              if (result === null || result.trim().length === 0) {
                releaseUpgrade();
                return new Response("unauthorized", { status: 401 });
              }
              identity = result;
            }
          } catch (err) {
            releaseUpgrade();
            throw err;
          }
          // Post-auth lifecycle fence: if disconnect ran while
          // authenticate() was in flight, refuse to proceed to
          // srv.upgrade(). The single-client slot must not be claimed
          // on an adapter the host already tore down. 410 Gone signals
          // the resource is permanently unavailable for this auth
          // attempt; clients should retry against a fresh connect.
          if (connectGen !== genAtFetch) {
            releaseUpgrade();
            return new Response("adapter disconnected", { status: 410 });
          }
          // Phase 2 begins: arm the safety timer only now, scoped to the
          // post-upgrade / pre-open() gap. Slow auth above could not have
          // released the slot.
          // Reservation expiry MUST invalidate this specific upgrade, not
          // just decrement the counter. Without isExpired(), a stalled
          // open() whose timer fired could later still claim activeSocket
          // (the timer freed the slot, a fresh client B raced in, A's
          // delayed open() fires before B's, A binds the channel, B is
          // rejected — stale wins, fresh loses). The flag fences A out.
          // let requires justification: closure flag mutated by timer
          let reservationExpired = false;
          const reservationTimer = setTimeout(() => {
            reservationExpired = true;
            releaseUpgrade();
          }, UPGRADE_RESERVATION_TIMEOUT_MS);
          const isReservationExpired = (): boolean => reservationExpired;
          if (
            srv.upgrade(req, {
              data: {
                identity,
                releaseUpgrade,
                reservationTimer,
                isReservationExpired,
                gen: genAtFetch,
              },
            })
          ) {
            return undefined;
          }
          clearTimeout(reservationTimer);
          releaseUpgrade();
          return new Response("expected websocket", { status: 426 });
        },
        websocket: {
          open(
            ws: SocketLike & {
              readonly data?: {
                readonly identity?: string;
                readonly releaseUpgrade?: () => void;
                readonly reservationTimer?: ReturnType<typeof setTimeout>;
                readonly isReservationExpired?: () => boolean;
                readonly gen?: number;
              };
            },
          ) {
            // Lifecycle fence: if disconnect ran between fetch() and
            // open(), this upgrade was for a generation the host has
            // already abandoned. Refuse to bind activeSocket so a new
            // post-reconnect adapter (or no adapter) is not stranded
            // with a stale client.
            if (ws.data?.gen !== undefined && ws.data.gen !== connectGen) {
              if (ws.data?.reservationTimer !== undefined) {
                clearTimeout(ws.data.reservationTimer);
              }
              if (ws.data?.releaseUpgrade !== undefined) {
                ws.data.releaseUpgrade();
              }
              ws.close();
              return;
            }
            // Expired-reservation guard MUST run before we touch
            // activeSocket: if our reservation already timed out, a
            // newer client may already hold (or be about to hold) the
            // slot, and binding this stale socket would either kick the
            // fresh client out or admit a half-dead client.
            if (ws.data?.isReservationExpired?.() === true) {
              ws.close();
              return;
            }
            // open() owns the pendingUpgrades decrement that fetch()
            // deferred on success — the slot reservation now transitions
            // from in-flight to claimed (or, if a race somehow already
            // gave the slot away, just released). Cancel the safety
            // timeout first so it cannot double-decrement later.
            if (ws.data?.reservationTimer !== undefined) {
              clearTimeout(ws.data.reservationTimer);
            }
            if (ws.data?.releaseUpgrade !== undefined) {
              ws.data.releaseUpgrade();
            } else if (pendingUpgrades > 0) {
              pendingUpgrades--;
            }
            // Strict single-client: a second concurrent connection is REJECTED,
            // not allowed to preempt. Removes the cross-client misroute class.
            if (activeSocket !== undefined) {
              ws.close();
              return;
            }
            activeSocket = ws;
            activeIdentity = ws.data?.identity;
            sessionEpoch++;
            // Fresh per-session nonce — 128 bits of randomness signed into
            // every reply tag for this session. Cross-instance / cross-
            // restart replays cannot reproduce it, so they cannot pass the
            // live-delivery nonce-equality check.
            sessionNonce = randomBytes(16).toString("hex");
          },
          message(ws: SocketLike, data: string | Uint8Array) {
            // Hard gate: the WS close handshake is asynchronous, so a
            // rejected (non-active) socket can race a `message` event in.
            if (ws !== activeSocket) {
              ws.close();
              return;
            }
            // Trust-boundary size cap MUST run before any decode/alloc so
            // an attacker cannot force an oversized binary frame to
            // allocate a megabyte-scale TextDecoder output before the
            // 64-KiB guard kicks in. Reject frames over the cap on the
            // raw bytes; for binary frames also short-circuit decoding.
            if (typeof data === "string") {
              if (Buffer.byteLength(data, "utf8") > MAX_INBOUND_FRAME_BYTES) {
                return;
              }
              if (lineHandler !== undefined) {
                lineHandler(data);
              } else if (pendingLines.length < MAX_PENDING_LINES) {
                pendingLines.push(data);
              }
              return;
            }
            // Binary frame: this protocol is JSON-over-text. Reject any
            // binary payload — there is no legitimate sender. (Also
            // closes the byte-vs-decoded-codepoint discrepancy: invalid
            // UTF-8 could otherwise alter post-decode length and bypass
            // the cap.)
            if (data.byteLength > 0) {
              return;
            }
          },
          close(ws: SocketLike) {
            if (activeSocket === ws) {
              activeSocket = undefined;
              activeIdentity = undefined;
              // Frames buffered during the just-closed session must not
              // be replayed into the next session's handler with the
              // wrong identity context.
              pendingLines = [];
              sessionEpoch++;
              // Clear the nonce so any in-flight reply still carrying the
              // just-closed session's nonce fails the equality check until
              // the next open() generates a fresh one.
              sessionNonce = "";
              // Reject any in-flight ack waits with the timeout sentinel
              // so platformSend's catch arm routes them to push fallback.
              // Without this they would hang until ackTimeoutMs naturally
              // elapsed even though the socket is already gone.
              for (const [id, pending] of pendingAcks) {
                clearTimeout(pending.timer);
                pendingAcks.delete(id);
                pending.reject(ACK_TIMEOUT_SENTINEL);
              }
            }
          },
        },
      });
    },
    // Pre-drain hook: rejected ack waits BEFORE channel-base awaits the
    // send chain, otherwise a disconnect during an unacked live send
    // would block for the full ackTimeoutMs before platformDisconnect
    // ran — stalling shutdown / failover under packet loss.
    prePlatformDisconnect: () => {
      shuttingDown = true;
      // Reject pending ack waits so platformSend's catch arm can promote
      // them to push (or reject with no-target) and the chain drains
      // immediately instead of stalling on the per-message ack timeout.
      for (const [id, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pendingAcks.delete(id);
        pending.reject(ACK_TIMEOUT_SENTINEL);
      }
    },
    platformDisconnect: async () => {
      // Bump the connect-cycle generation FIRST so any auth/upgrade
      // work currently in flight (captured genAtFetch === old connectGen)
      // detects the lifecycle change after it eventually resumes and
      // refuses to claim activeSocket on this torn-down adapter.
      connectGen++;
      activeSocket?.close();
      activeSocket = undefined;
      activeIdentity = undefined;
      // Drop any frames buffered during the prior session's startup gap so
      // they cannot be replayed into the next session's handler with
      // stale identity context.
      pendingLines = [];
      pendingUpgrades = 0;
      sessionNonce = "";
      // Drain pending ack waits — fail them via the sentinel so
      // platformSend's catch arm routes them to push fallback.
      for (const [id, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pendingAcks.delete(id);
        pending.reject(ACK_TIMEOUT_SENTINEL);
      }
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
      // Round-40 high: explicit recipient supplied by sendUnsolicited(msg, {recipient}).
      // Honored ONLY for verified-unsolicited sends so an unsigned external
      // outbound cannot smuggle a recipient string into the push fallback.
      const rawExplicit = message.metadata?.[UNSOLICITED_RECIPIENT_KEY];
      const explicitRecipient =
        isUnsolicited && typeof rawExplicit === "string" && rawExplicit.length > 0
          ? rawExplicit
          : undefined;
      const hasReplyField =
        message.metadata?.[EPOCH_KEY] !== undefined || message.metadata?.[MAC_KEY] !== undefined;
      const verifiedReply = extractAndVerifyReply(message, verify);
      const alsCtx = sessionContext.getStore();
      // let requires justification: classification depends on signal presence
      let liveRecipient: boolean;
      if (hasUnsolicitedField) {
        // Present-but-invalid unsolicited tag → fail closed.
        // Round-41 high: when caller supplied an explicit `recipient` via
        // sendUnsolicited(msg, {recipient}), the live socket must be the
        // SAME authenticated user — otherwise the message would deliver
        // to whoever is connected (e.g., to Bob when Alice was the
        // intended recipient). Mismatched recipient bypasses live and
        // routes through pushNotifier so the host can deliver to Alice.
        const recipientMatchesLive =
          explicitRecipient === undefined ||
          (activeIdentity !== undefined && explicitRecipient === activeIdentity);
        liveRecipient = isUnsolicited && activeSocket !== undefined && recipientMatchesLive;
      } else if (hasReplyField) {
        // Present-but-invalid OR foreign reply tag (incl. mutated recipient
        // fields that no longer match the signed envelope) → fail closed.
        // Also enforce that the verified recipient identity matches the
        // CURRENTLY connected authenticated identity. Without this check,
        // two adapter instances sharing a signingSecret could live-deliver
        // each other's tagged replies whenever they happen to be on the
        // same epoch — a cross-user message leak. Identity match means a
        // live write is only allowed when the same user is connected here
        // as the one who originated the inbound being replied to.
        // Nonce equality is what makes a stable signingSecret safe across
        // restarts: even if a stale tag still verifies HMAC and the same
        // identity reconnects on the same epoch counter, the per-session
        // nonce (16 random bytes regenerated on every accepted open()) is
        // unguessable and unrecoverable from any cross-instance state, so
        // off-session replies can never live-deliver.
        liveRecipient =
          verifiedReply !== undefined &&
          verifiedReply.epoch === sessionEpoch &&
          verifiedReply.nonce === sessionNonce &&
          sessionNonce.length > 0 &&
          activeSocket !== undefined &&
          verifiedReply.senderId === (activeIdentity ?? defaultSenderId);
      } else if (alsCtx !== undefined) {
        // Same identity + nonce guards for ALS-tagged sends. ALS context
        // can outlive its session if a handler captures it into a detached
        // callback; the nonce check stops that captured ctx from being used
        // to live-deliver into a later session.
        liveRecipient =
          alsCtx.epoch === sessionEpoch &&
          alsCtx.nonce === sessionNonce &&
          sessionNonce.length > 0 &&
          activeSocket !== undefined &&
          alsCtx.senderId === (activeIdentity ?? defaultSenderId);
      } else {
        liveRecipient = false;
      }
      // Strip our internal metadata fields before they cross the wire — the
      // remote client has no use for them.
      const wireMessage = stripInternalMetadata(message);
      // Identity captured if we reached the live-write path. Used to
      // route the immediate-fallback push (write returned <= 0 before
      // any bytes hit the wire) to the same authenticated user we were
      // about to deliver to. Without this, an unsolicited send whose
      // socket closed mid-write would push with no recipient context.
      // let requires justification: assigned only on live-attempt path
      let liveAttemptIdentity: string | undefined;
      // Disconnect race: a send queued in channel-base's chain may
      // reach platformSend AFTER prePlatformDisconnect already drained
      // pendingAcks. Skip the live path entirely so we don't arm a new
      // ack wait that nothing will ever drain.
      if (liveRecipient && activeSocket !== undefined && !shuttingDown) {
        // Application-level ack: a fresh deliveryId rides on the wire
        // payload. The client must respond with `{kind:"ack",deliveryId}`
        // within ackTimeoutMs to confirm receipt — otherwise the radio
        // could drop the frame after socket.send() reports it queued and
        // the user would never see it. On timeout we fall through to
        // push (or reject with no-target) so delivery is never silently
        // lost. ackTimeoutMs <= 0 disables the protocol.
        const deliveryId = randomBytes(12).toString("hex");
        const payload = JSON.stringify({
          kind: "msg",
          ...wireMessage,
          deliveryId,
          timestamp: Date.now(),
        });
        const expectedBytes = new TextEncoder().encode(payload).byteLength;
        const socketAtSend = activeSocket;
        // Capture identity at live-write time so an ack-timeout
        // fallback later targets the SAME user we wrote to. Reading
        // the global activeIdentity from the fallback would cross-
        // route to whoever is connected then if A disconnected and
        // B reconnected in between.
        const identityAtSend = activeIdentity ?? defaultSenderId;
        liveAttemptIdentity = identityAtSend;
        // let requires justification: capture write outcome
        let written = 0;
        try {
          written = socketAtSend.send(payload);
        } catch {
          written = -1;
        }
        if (written >= expectedBytes) {
          if (ackTimeoutMs <= 0) return;
          // Wait for the client ack OR timeout, whichever fires first.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (pendingAcks.delete(deliveryId)) {
                // Promote to push fallback below by rejecting with a
                // sentinel that the catch arm translates into pushNotifier.
                reject(ACK_TIMEOUT_SENTINEL);
              }
            }, ackTimeoutMs);
            pendingAcks.set(deliveryId, { resolve, reject, timer });
          }).then(
            () => undefined,
            async (err) => {
              if (err !== ACK_TIMEOUT_SENTINEL) throw err;
              if (config.pushNotifier === undefined) {
                throw new MobileNoDeliveryTargetError();
              }
              await config.pushNotifier(
                wireMessage,
                derivePushContext(
                  verifiedReply,
                  alsCtx,
                  deliveryId,
                  identityAtSend,
                  explicitRecipient,
                ),
              );
            },
          );
          return;
        }
        // Partial write (0 < written < expectedBytes) is the dangerous case:
        // some bytes are already on the wire, so falling through to
        // pushNotifier would deliver the same logical message twice (once
        // truncated/garbled live, once complete via push). Close the socket
        // to terminate the corrupt frame stream and surface the failure to
        // the caller; idempotent retry is the host's responsibility.
        if (written > 0) {
          socketAtSend.close();
          throw new MobilePartialWriteError(deliveryId, written, expectedBytes);
        }
        // written <= 0: nothing reached the wire (closed / -1 / 0), so it
        // is safe to fall through to push without risk of duplication.
      }
      if (config.pushNotifier === undefined) {
        throw new MobileNoDeliveryTargetError();
      }
      await config.pushNotifier(
        wireMessage,
        derivePushContext(verifiedReply, alsCtx, undefined, liveAttemptIdentity, explicitRecipient),
      );
    },
    onPlatformEvent: (handler) => {
      lineHandler = handler;
      // Drain any frames that arrived during the connect/setup window
      // BEFORE the handler was installed. Without this, the first inbound
      // after a fresh restart would be silently lost.
      const drain = pendingLines;
      pendingLines = [];
      for (const line of drain) handler(line);
      return () => {
        lineHandler = undefined;
      };
    },
    normalize: (line: string): InboundMessage | null => {
      // Bound memory pressure from oversized client frames before parsing.
      // Use UTF-8 byte length, NOT string.length (UTF-16 code units), so
      // multi-byte payloads (CJK, emoji) cannot exceed the documented cap
      // by 3-4x and bypass the only memory guard at this trust boundary.
      if (Buffer.byteLength(line, "utf8") > MAX_INBOUND_FRAME_BYTES) return null;
      try {
        const frame = JSON.parse(line) as InboundFrame;
        // Application-level ack from the client confirming receipt of a
        // prior live-delivered frame. Resolves the pending send and
        // clears the timeout so it cannot fall through to push later.
        if (frame.kind === "ack" && typeof frame.deliveryId === "string") {
          const pending = pendingAcks.get(frame.deliveryId);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            pendingAcks.delete(frame.deliveryId);
            pending.resolve();
          }
          // Acks are wire-protocol frames, not user messages — never
          // dispatch them to message handlers.
          return null;
        }
        if (frame.kind !== "msg") return null;
        const rawContent = frame.content ?? [];
        if (!Array.isArray(rawContent) || rawContent.length === 0) return null;
        // Reject any frame containing a malformed ContentBlock — never
        // smuggle untyped client objects into downstream handlers as
        // ContentBlock[].
        const content = validateContentBlocks(rawContent);
        if (content === null) return null;
        // Trust-mode senderId validation: a buggy or hostile client could
        // emit a non-string / empty / null senderId via JSON.parse. The
        // InboundMessage contract requires a string and HMAC signing /
        // push routing assume a real identity. Drop the frame if trust
        // mode is on AND a present-but-malformed senderId is supplied;
        // an absent field is fine (falls back to defaults). When trust
        // mode is off the client field is ignored entirely, so no check.
        if (
          trustClient &&
          frame.senderId !== undefined &&
          (typeof frame.senderId !== "string" || frame.senderId.length === 0)
        ) {
          return null;
        }
        // Identity precedence: server-authenticated handshake wins over
        // client-supplied (even when trusted) wins over host placeholder.
        // The authenticate() identity is the strongest server-side signal.
        const senderId =
          activeIdentity ?? (trustClient ? (frame.senderId ?? defaultSenderId) : defaultSenderId);
        // When trustClientIdentity is on but no authenticate() handshake
        // bound an identity at upgrade time, promote the first inbound's
        // trusted senderId into activeIdentity so the strict-reply identity
        // match in platformSend compares against the real client identity
        // (e.g., "device-1") rather than the host placeholder. Without
        // this, every reply for a trusted-client session would mismatch
        // and route to push (or fail) even though the right client is
        // still on the wire. Locked for the duration of the session — a
        // mid-session senderId change in subsequent frames is ignored.
        if (trustClient && activeIdentity === undefined && activeSocket !== undefined) {
          activeIdentity = senderId;
        }
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
        const tagThread = inbound.threadId ?? "";
        const signedInbound: InboundMessage = {
          ...inbound,
          metadata: {
            ...(inbound.metadata ?? {}),
            [EPOCH_KEY]: sessionEpoch,
            [MAC_KEY]: sign(sessionEpoch, sessionNonce, inbound.senderId, tagThread),
            [ORIGIN_SENDER_KEY]: inbound.senderId,
            ...(inbound.threadId !== undefined ? { [ORIGIN_THREAD_KEY]: inbound.threadId } : {}),
            [ORIGIN_NONCE_KEY]: sessionNonce,
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
        const metaNonce = msg.metadata?.[ORIGIN_NONCE_KEY];
        const ctx: AlsCtx = {
          epoch: typeof metaEpoch === "number" ? metaEpoch : sessionEpoch,
          nonce: typeof metaNonce === "string" ? metaNonce : sessionNonce,
          senderId: typeof metaSender === "string" ? metaSender : msg.senderId,
          ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
        };
        return sessionContext.run(ctx, () => handler(msg));
      }),
    sendUnsolicited: (
      message: OutboundMessage,
      opts?: MobileSendUnsolicitedOptions,
    ): Promise<void> => {
      const recipient = opts?.recipient;
      const metadata: Record<string, unknown> = {
        ...(message.metadata ?? {}),
        [UNSOLICITED_MAC_KEY]: unsolicitedTag,
      };
      if (recipient !== undefined && recipient.length > 0) {
        metadata[UNSOLICITED_RECIPIENT_KEY] = recipient;
      }
      return inner.send({ ...message, metadata });
    },
  };
  if (inner.sendStatus !== undefined) {
    const fn = inner.sendStatus;
    return { ...wrapped, sendStatus: (s: ChannelStatus) => fn(s) };
  }
  return wrapped;
}
