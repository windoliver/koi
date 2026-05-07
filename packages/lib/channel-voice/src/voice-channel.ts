import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";

/**
 * Audio I/O transport for the voice channel. Vendor wiring (LiveKit, Twilio,
 * a local PCM pipeline, etc.) lives here.
 *
 * **Session identity** — every inbound and outbound carries an opaque
 * `sessionId` string identifying the call/leg/track the audio belongs to.
 * The voice channel surfaces it as `InboundMessage.threadId` and accepts
 * it back via `OutboundMessage.threadId` so the host can fan multiple live
 * sessions through one adapter without cross-talk. Hosts SHOULD mint a
 * fresh sessionId per logical call rather than reusing a constant id —
 * a transport-send timeout permanently poisons the threadId for the
 * adapter's lifetime (the stale call could still surface audio later
 * and reorder with newer audio on the same id), so a stable id like
 * `"default"` would brick on a single transient timeout. Per-call
 * fresh ids isolate failures to the affected call.
 *
 * **Inbound contract:** `onUtterance` MUST deliver complete utterance
 * buffers (upstream voice-activity-detected / endpointed). The voice
 * channel calls `stt.transcribe()` once per emitted buffer; emitting
 * per-packet would fragment transcripts and explode STT cost.
 *
 * **Outbound contract:** `sendUtterance` is invoked with the FULL ordered
 * sequence of audio frames for one reply, atomically, plus a unique
 * `utteranceId` (a fresh hex string per channel-level send call). The
 * transport is responsible for either delivering the entire utterance
 * or surfacing a single failure that leaves the user-audible state in a
 * defined position. The channel does NOT stream chunk-by-chunk and does
 * NOT supply resume tokens.
 *
 * **Idempotent dedup MUST be enforced by the transport keyed on
 * `utteranceId`**: if the channel-level send is retried (whether by the
 * host or by an upstream retry middleware) the same `utteranceId` is
 * passed in. The transport must not double-play. Without this contract,
 * a transport that streams frames then errors mid-playback would force
 * the caller to choose between losing audio (no retry) or duplicating
 * playback prefixes (blind retry). With it, the transport can suppress
 * a re-play whose id matches a recently-completed delivery.
 */
export interface VoiceTransport {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  /**
   * Send an utterance. The optional `signal` aborts when the channel
   * has given up on this send (timeout). Implementations MUST honor
   * it — stop emitting frames, free transport resources, and reject
   * promptly so the channel can fence the call cleanly before
   * `disconnect()` clears the per-session poison flag. A transport
   * that ignores the abort signal forfeits the channel's ordering
   * guarantee on reconnect: a stale send may surface AFTER newer audio
   * for the same `sessionId`, and the channel cannot detect the leak.
   * Hosts whose transport cannot guarantee abort honoring MUST
   * construct a fresh adapter on reconnect rather than reusing the
   * disconnected one.
   */
  readonly sendUtterance: (
    sessionId: string,
    utteranceId: string,
    frames: readonly Uint8Array[],
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly onUtterance: (handler: (sessionId: string, utterance: Uint8Array) => void) => () => void;
}

/**
 * Speech-to-text. Returning `null` skips dispatch (e.g., silence /
 * no speech detected). `signal` aborts when the channel has timed
 * out the transcription attempt; implementations MUST honor it to
 * free provider resources / quota and reject promptly. Without
 * cancellation, a black-holed network can accumulate unbounded
 * abandoned STT calls behind dropped turns.
 */
export interface Stt {
  readonly transcribe: (audio: Uint8Array, signal?: AbortSignal) => Promise<string | null>;
}

/**
 * Text-to-speech. Returns the encoded audio buffer to hand to the transport.
 * `signal` aborts when the channel has timed out the synthesis attempt.
 * Implementations MUST honor it to free provider resources and reject
 * promptly so the channel can clear per-session poison on disconnect.
 * Non-cooperative impls leak compute (and potentially audio if the
 * transport later receives the synthesized buffer post-abort).
 */
export interface Tts {
  readonly synthesize: (text: string, signal?: AbortSignal) => Promise<Uint8Array>;
}

export interface VoiceChannelConfig {
  readonly transport: VoiceTransport;
  readonly stt: Stt;
  readonly tts: Tts;
  readonly senderId?: string;
  readonly maxTtsChars?: number;
  /**
   * Invoked when STT transcription throws/rejects on an inbound audio frame.
   * Defaults to a `console.warn` so a transient STT outage is at least
   * observable in stderr instead of silently masquerading as user silence.
   * Hosts SHOULD override this with their own logging / metrics / status
   * pipeline; passing `() => {}` explicitly opts into silent drop.
   */
  readonly onSttError?: (error: unknown, frame: Uint8Array) => void;
  /**
   * Maximum milliseconds to wait for `stt.transcribe()` on a single
   * utterance before treating it as failed. STT is serialized per
   * sessionId so a hung request would otherwise block every later
   * utterance for that call indefinitely (one-way voice outage).
   * On timeout the chain advances, the utterance is dropped, and
   * `onSttError` fires with a `VoiceSttTimeoutError`. Default 30 s.
   */
  readonly sttTimeoutMs?: number;
  /**
   * Maximum milliseconds to wait for `tts.synthesize()` on a single text
   * chunk before treating it as failed. Default 30 s. The send rejects
   * with `VoiceTtsTimeoutError` so a stuck TTS provider cannot hang the
   * caller indefinitely.
   */
  readonly ttsTimeoutMs?: number;
  /**
   * Maximum milliseconds the per-session ordering chain waits for the
   * downstream `onMessage` handler returned by a previous utterance to
   * settle before admitting the next utterance for the same `sessionId`.
   * STT/TTS/transport each have their own timeouts, but runtime work
   * inside the handler does not — without this watchdog, a single hung
   * handler call would queue every later utterance behind a dead
   * promise indefinitely, with no way to recover short of disconnecting.
   * On expiry the chain entry is dropped and the next utterance proceeds;
   * the original handler promise is left to settle on its own. Default
   * 60 s.
   */
  readonly dispatchHandlerTimeoutMs?: number;
  /**
   * Maximum milliseconds to wait for `transport.sendUtterance()` to
   * resolve. Default 30 s. The send rejects with
   * `VoiceTransportSendTimeoutError` on expiry.
   */
  readonly transportSendTimeoutMs?: number;
}

/** Thrown into `onSttError` when STT exceeds `sttTimeoutMs`. */
export class VoiceSttTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`@koi/channel-voice: STT transcribe exceeded ${String(timeoutMs)}ms`);
    this.name = "VoiceSttTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown from `send()` when `tts.synthesize()` exceeds `ttsTimeoutMs`. */
export class VoiceTtsTimeoutError extends Error {
  readonly timeoutMs: number;
  /** Effective utteranceId for the timed-out send. Carry on retry to dedupe. */
  readonly utteranceId: string | undefined;
  /** Originating session/threadId for the timed-out send. */
  readonly sessionId: string | undefined;
  constructor(timeoutMs: number, utteranceId?: string, sessionId?: string) {
    super(`@koi/channel-voice: TTS synthesize exceeded ${String(timeoutMs)}ms`);
    this.name = "VoiceTtsTimeoutError";
    this.timeoutMs = timeoutMs;
    this.utteranceId = utteranceId;
    this.sessionId = sessionId;
  }
}

/**
 * Thrown from `send()` when `transport.sendUtterance()` exceeds
 * `transportSendTimeoutMs`. The error carries the effective `utteranceId`
 * (whether host-supplied via `metadata.utteranceId` or adapter-minted)
 * so retry middleware can replay with the same dedupe key — the
 * transport contract guarantees idempotent suppression keyed on
 * `utteranceId`. `sessionId` is the originating threadId.
 */
export class VoiceTransportSendTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly utteranceId: string | undefined;
  readonly sessionId: string | undefined;
  constructor(timeoutMs: number, utteranceId?: string, sessionId?: string) {
    super(`@koi/channel-voice: transport.sendUtterance exceeded ${String(timeoutMs)}ms`);
    this.name = "VoiceTransportSendTimeoutError";
    this.timeoutMs = timeoutMs;
    this.utteranceId = utteranceId;
    this.sessionId = sessionId;
  }
}

/**
 * Thrown when `send()` is called on a session whose previous outbound
 * exceeded `transportSendTimeoutMs` (or whose handler is invoked from
 * a now-disconnected generation). The original transport call could
 * not be aborted and may still surface audio later, so accepting newer
 * sends on the same `threadId` would risk overlapping/reordered
 * playback. Recovery options:
 *
 *  - Use a different `threadId` on the same adapter (most realistic
 *    for hosts that mint a unique session id per call).
 *  - Construct a fresh adapter (required for hosts using a stable/
 *    reused `threadId` whose transport ignored the abort signal).
 *
 * `disconnect()` + `connect()` does NOT clear poison for the same
 * `threadId` — a stale transport call could still surface audio on
 * a reconnected transport, and the channel cannot detect that.
 */
export class VoicePoisonedSessionError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `@koi/channel-voice: session ${sessionId} is poisoned by a prior transport-send timeout; the stale operation may still complete and would reorder with new audio. Use a different threadId or construct a fresh adapter to recover.`,
    );
    this.name = "VoicePoisonedSessionError";
    this.sessionId = sessionId;
  }
}

const DEFAULT_STT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSPORT_SEND_TIMEOUT_MS = 30_000;
// Watchdog for the per-session dispatch wait. STT/TTS/transport each have
// their own timeouts, but the runtime/tool work inside `onMessage` does
// not — a single hung handler must not wedge every later utterance for
// the same sessionId behind a dead promise. After this elapses we drop
// the chain entry and let the next utterance proceed; the original
// handler promise is left to settle on its own.
const DEFAULT_DISPATCH_HANDLER_TIMEOUT_MS = 60_000;

/**
 * Metadata key carrying the connect-cycle epoch a reply belongs to.
 * Stamped on every inbound by the adapter; surviving copies on
 * outbound (via metadata propagation or `replyToVoiceInbound`) let
 * `wrappedSend` reject stale detached replies that would otherwise
 * speak into a later call on a reused threadId.
 */
export const VOICE_CALL_EPOCH_KEY = "voiceCallEpoch";

/**
 * Per-turn token (debug/trace stamp). Minted for every inbound and copied
 * by `replyToVoiceInbound`. NOT used for fencing as of round 52 — see
 * `VOICE_SESSION_GEN_KEY` for the durable rejection mechanism. Retained
 * for observability and backward metadata compatibility.
 */
export const VOICE_TURN_ID_KEY = "voiceTurnId";

/**
 * Round-52 high: monotonic per-session call generation. Replaces the
 * previous global FIFO tombstone (`expiredTurnIds`, capped at 1024) which
 * silently lost safety state under busy/long-lived workloads — a delayed
 * reply tagged with an evicted turn id became admissible again. The
 * counter is per `sessionId`, in-process, never evicted while the
 * connection is live, and bumps on:
 *   • `endCall(sessionId)` — explicit host-driven call boundary, OR
 *   • the dispatch watchdog firing for a turn in that session.
 * Inbound stamps `voiceSessionGen` at admission time; `wrappedSend`
 * rejects any reply whose stamped gen is less than the session's current
 * gen. Single integer per session, no global eviction, no memory growth
 * proportional to total utterances.
 */
export const VOICE_SESSION_GEN_KEY = "voiceSessionGen";

/**
 * Originating session/threadId stamped on detached replies. Round-46 fix:
 * `voiceCallEpoch` + `voiceTurnId` proved the reply belongs to a turn, but
 * NOT to which call's threadId. A delayed background reply built from call
 * A's inbound could be redirected to call B by mutating `threadId` before
 * `send()` (concurrent-call leak). The helper now stamps `voiceOriginThreadId`
 * AND overwrites the outbound `threadId` from the inbound; `wrappedSend`
 * rejects when an outbound carrying this stamp is sent to a different thread.
 */
export const VOICE_ORIGIN_THREAD_KEY = "voiceOriginThreadId";

/**
 * Copy the per-call epoch tag from an inbound onto an outbound reply.
 * Use this in any callsite where the reply is built outside the
 * inbound's ALS scope (e.g., after `await`-ing an external work
 * promise that crosses ALS boundaries, or when fanning into a
 * background queue and replying later). Without the tag, a
 * detached send issued after disconnect/reconnect could leak into
 * a fresh call sharing the same threadId.
 */
export function replyToVoiceInbound(
  inbound: InboundMessage,
  outbound: OutboundMessage,
): OutboundMessage {
  const inboundEpoch = inbound.metadata?.[VOICE_CALL_EPOCH_KEY];
  const inboundTurnId = inbound.metadata?.[VOICE_TURN_ID_KEY];
  const inboundSessionGen = inbound.metadata?.[VOICE_SESSION_GEN_KEY];
  const inboundThread = inbound.threadId;
  const next: Record<string, unknown> = { ...(outbound.metadata ?? {}) };
  // let requires justification: nothing-to-copy is a valid no-op
  let copied = false;
  if (typeof inboundEpoch === "number") {
    next[VOICE_CALL_EPOCH_KEY] = inboundEpoch;
    copied = true;
  }
  if (typeof inboundTurnId === "string" && inboundTurnId.length > 0) {
    next[VOICE_TURN_ID_KEY] = inboundTurnId;
    copied = true;
  }
  if (typeof inboundSessionGen === "number") {
    next[VOICE_SESSION_GEN_KEY] = inboundSessionGen;
    copied = true;
  }
  // Round-46 high: bind the reply to the originating session. Without
  // this, a delayed reply could be redirected into a concurrent call by
  // changing `threadId` before send() (epoch+turnId would still match).
  // Always overwrite outbound `threadId` from the inbound so the helper
  // is the safe default; the originating thread also rides on metadata
  // so wrappedSend can reject any later mutation.
  if (typeof inboundThread === "string" && inboundThread.length > 0) {
    next[VOICE_ORIGIN_THREAD_KEY] = inboundThread;
    copied = true;
  }
  if (!copied) return outbound;
  return {
    ...outbound,
    ...(typeof inboundThread === "string" && inboundThread.length > 0
      ? { threadId: inboundThread }
      : {}),
    metadata: next,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  // let requires justification: timer ref captured for cleanup
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const defaultSttErrorLogger = (error: unknown, frame: Uint8Array): void => {
  // Default-on observability: at minimum, leave a breadcrumb in stderr so a
  // failing STT pipeline does not look identical to the user being silent.
  // eslint-disable-next-line no-console
  console.warn(
    `[@koi/channel-voice] STT transcribe failed on ${frame.byteLength}-byte frame:`,
    error,
  );
};

// Capabilities advertise honestly what voice CAN deliver natively: text
// (via TTS) and audio. Images/files/buttons are NOT natively rendered, so
// upstream routing/fallback decisions must see them as `false`. Rich-block
// preservation is handled by a voice-specific rendering pass installed
// AROUND channel-base (see `createVoiceChannel` below) — before base's
// renderBlocks reduces them to a lossy generic fallback.
const VOICE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: true,
  video: false,
  threads: true,
  supportsA2ui: false,
};

export class VoiceMissingSessionError extends Error {
  constructor() {
    super(
      "@koi/channel-voice: OutboundMessage.threadId is required (the transport sessionId of the call to reply to). Strict per-session routing prevents cross-talk between concurrent voice sessions.",
    );
    this.name = "VoiceMissingSessionError";
  }
}

const DEFAULT_MAX_TTS_CHARS = 240;

function chunk(text: string, max: number): readonly string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/**
 * Voice channel adapter — extends `ChannelAdapter` with two epoch-tagging
 * helpers needed for legitimate post-reconnect outbound. `wrappedSend`
 * fences any send made outside the inbound ALS scope unless it carries a
 * matching `voiceCallEpoch` metadata tag; these helpers are the supported
 * way for hosts to mint such a tag for server-initiated speech.
 */
export type VoiceChannelAdapter = ChannelAdapter & {
  /**
   * Returns a clone of `outbound` stamped with the current connection
   * epoch, the current per-session call generation for `sessionId`, and
   * the originating session/threadId. Round-53 high: the prior
   * `stampForCurrentCall(outbound)` (no sessionId) bypassed the per-
   * session boundary set by `endCall(sessionId)` because it stamped
   * only the connection epoch — a stamped send for a freshly ended
   * call still admitted. Now session-aware: callers MUST name the
   * session they're speaking on, and the stamp tracks that session's
   * current incarnation.
   */
  readonly stampForCurrentCall: (sessionId: string, outbound: OutboundMessage) => OutboundMessage;
  /** Read-only view of the current call epoch for hosts that prefer to stamp manually. */
  readonly currentCallEpoch: () => number;
  /**
   * Round-48 high: explicit host-driven call-incarnation boundary. When the
   * host detects that the logical call on `sessionId` has ended (hangup,
   * inactivity timeout, transport-side EOC marker, etc.), call this to
   * expire the current turn id for that session. Any subsequent detached
   * reply tagged with the just-expired turn id is rejected by `wrappedSend`,
   * even if the same `sessionId` is reused for a new call.
   *
   * Hosts that mint a unique `sessionId` per logical call (the documented
   * preferred contract) do not need to call this — the per-turn id is
   * already isolated by the unique session. `endCall` exists for hosts
   * whose transport reuses a stable `sessionId` across calls.
   */
  readonly endCall: (sessionId: string) => void;
};

export function createVoiceChannel(config: VoiceChannelConfig): VoiceChannelAdapter {
  const senderId = config.senderId ?? "voice-user";
  const maxTtsChars = config.maxTtsChars ?? DEFAULT_MAX_TTS_CHARS;
  // Reject up front rather than hanging the outbound loop in chunk().
  if (!Number.isFinite(maxTtsChars) || maxTtsChars <= 0) {
    throw new Error(`maxTtsChars must be a positive finite number; got ${String(maxTtsChars)}`);
  }

  // Bridge transport's (sessionId, utterance) callback through the
  // single-arg `onPlatformEvent` adapter contract by tunneling sessionId
  // alongside the audio in a per-event tuple, then unpacking in normalize().
  // STT runs in onPlatformEvent (not normalize) so we can serialize STT
  // calls per sessionId — see the chain in onPlatformEvent below — and
  // guarantee that turn N's transcript is dispatched before turn N+1's
  // STT is even started, eliminating cross-turn reordering when STT
  // latency varies.
  interface TransportEvent {
    readonly sessionId: string;
    readonly utterance: Uint8Array;
    readonly text: string | null;
  }

  // Pre-render rich blocks to text BEFORE channel-base's renderBlocks
  // sees them. Capabilities are honestly false for images/files/buttons,
  // which would cause base to downgrade to a lossy generic fallback
  // (`[Image: alt]`). By collapsing them to `text` blocks here first,
  // base's renderBlocks becomes a passthrough and our rich spoken
  // representation reaches the wire intact.
  const renderBlockToSpokenText = (block: ContentBlock): string => {
    switch (block.kind) {
      case "text":
        return block.text;
      case "image":
        return block.alt !== undefined && block.alt.length > 0
          ? `Image: ${block.alt}`
          : `Image at ${block.url}`;
      case "file":
        return block.name !== undefined && block.name.length > 0
          ? `File ${block.name} (${block.mimeType}) at ${block.url}`
          : `File (${block.mimeType}) at ${block.url}`;
      case "button":
        return `Button: ${block.label}`;
      case "custom":
        return `[custom ${block.type}]`;
    }
  };

  // Bounded backlog of (sessionId, utterance) pairs that arrived between
  // transport.connect() returning and onPlatformEvent() registering its
  // handler. createChannelAdapter installs the inbound listener AFTER
  // platformConnect, so without buffering a caller who speaks immediately
  // after the transport comes up loses their first utterance — the user
  // has no retry signal, the conversation desyncs from the start.
  const MAX_PENDING_UTTERANCES = 32;
  // let requires justification: lifecycle state mutated across closures
  let rawUtteranceSink: ((sessionId: string, utterance: Uint8Array) => void) | undefined;
  let pendingUtterances: Array<{ sessionId: string; utterance: Uint8Array }> = [];
  let unsubTransport: (() => void) | undefined;

  // ALS pins the per-turn dispatch context. The STT chain enters the ALS
  // ONCE per inbound utterance — channel-base then fans out concurrently
  // to every registered onMessage handler INSIDE that ALS, so all
  // handlers for one turn share a single `turnToken` and push their
  // promises into a single `collector`. This is essential: previously
  // each wrapped handler invocation overwrote a per-handler tracker, so
  // the watchdog only fenced the last-registered handler's token. With
  // ≥2 async handlers (logging + business logic, etc.) an earlier hung
  // handler could resume past the watchdog and speak audio into the next
  // turn unfenced. Sharing the token closes that hole.
  //   • gen mismatch → handler awaited across disconnect/reconnect; reject.
  //   • token in expiredTurnTokens → the dispatch watchdog already gave up
  //     on this turn and admitted the next utterance for the same session;
  //     the late send must NOT speak audio from a stale turn into a fresh
  //     one (would overlap or reorder the conversation).
  const inboundGenContext = new AsyncLocalStorage<{
    readonly gen: number;
    readonly turnToken: object;
    readonly turnId: string;
    readonly sessionId: string;
    readonly sessionGen: number;
    readonly collector?: { readonly promises: Promise<unknown>[] };
  }>();
  // Round-52 high: per-session monotonic call generation. Replaces the
  // FIFO tombstone (rounds 43-49) which silently lost fences after 1024
  // newer expirations on busy/long-lived adapters. A single integer per
  // session — durable, no eviction, no memory growth proportional to
  // total utterances. Bumped by endCall() and by the dispatch watchdog.
  // Cleared on disconnect (the connection-epoch fence handles the
  // disconnect/reconnect boundary separately).
  const sessionCallGen = new Map<string, number>();
  const getSessionGen = (sessionId: string): number => sessionCallGen.get(sessionId) ?? 0;
  const bumpSessionGen = (sessionId: string): void => {
    sessionCallGen.set(sessionId, getSessionGen(sessionId) + 1);
  };
  // Round-51 high: hard call boundary. After endCall(sessionId), any
  // untagged send to that threadId must reject until a NEW inbound turn
  // for the session establishes a fresh incarnation. Without this, a
  // delayed old-call callback could call `ch.send({threadId: reused,
  // ...})` with no metadata and slip through (the existing untagged
  // fence only fires post-disconnect/reconnect). Cleared in the inbound
  // pipeline when the next turn arrives for this session.
  const sessionsAwaitingNewTurn = new Set<string>();
  // Per-turn fence. Inserted by the dispatch watchdog when a handler
  // exceeds dispatchHandlerTimeoutMs; checked by wrappedSend so a hung
  // handler that eventually wakes up cannot inject late audio into a
  // session whose ordering window has already closed. WeakSet so an
  // expired token gets GC'd as soon as the handler closes over it
  // releases — no cross-session memory growth.
  const expiredTurnTokens = new WeakSet<object>();

  // (Per-turn dispatch tracking lives entirely in the ALS collector
  // mutated below — no per-session map needed. Per-session ordering
  // is enforced by the chain in onPlatformEvent: each utterance's
  // .then() awaits the prior turn's collected handler promises before
  // admitting the next utterance.)

  const inner = createChannelAdapter<TransportEvent>({
    name: "voice",
    capabilities: VOICE_CAPABILITIES,
    onNormalizationError: (err: unknown, event: TransportEvent) =>
      (config.onSttError ?? defaultSttErrorLogger)(err, event.utterance),
    platformConnect: async () => {
      // Subscribe BEFORE calling transport.connect() so any utterance
      // emitted synchronously during connect is buffered, not lost.
      // The sink is filled in by onPlatformEvent (which wires the
      // per-session STT chain).
      unsubTransport = config.transport.onUtterance((sessionId, utterance) => {
        if (rawUtteranceSink !== undefined) {
          rawUtteranceSink(sessionId, utterance);
        } else if (pendingUtterances.length < MAX_PENDING_UTTERANCES) {
          pendingUtterances.push({ sessionId, utterance });
        }
      });
      // Roll back the pre-connect subscription if connect() throws so a
      // retry doesn't accumulate listeners. Without this, each transient
      // connect failure would double subsequent STT/TTS work.
      try {
        await config.transport.connect();
      } catch (err) {
        unsubTransport?.();
        unsubTransport = undefined;
        pendingUtterances = [];
        throw err;
      }
    },
    platformDisconnect: async () => {
      unsubTransport?.();
      unsubTransport = undefined;
      pendingUtterances = [];
      rawUtteranceSink = undefined;
      await config.transport.disconnect();
    },
    // platformSend is intentionally a no-op stub. channel-base serializes
    // all sends through a single global promise chain, which would let
    // one stuck TTS or stalled transport.sendUtterance() head-of-line
    // block every other live voice session. Voice instead overrides the
    // wrapper send() below to do per-`threadId` serialization with
    // bounded TTS / transport timeouts, so concurrent calls cannot freeze
    // each other. Anyone bypassing the wrapper and calling inner.send()
    // directly will get this error rather than silently sending nothing.
    platformSend: async () => {
      throw new Error(
        "@koi/channel-voice: inner platformSend must not be called directly; use the wrapper send() which handles per-session concurrency",
      );
    },
    onPlatformEvent: (handler) => {
      // Per-session full-pipeline serialization. The chain holds for
      // STT AND for handler dispatch (when the host's onMessage handler
      // returns a Promise via the per-session dispatch awaiter wired
      // below). Without this, two utterances on the same call leg
      // could overlap their handler work — mutating shared session
      // state concurrently or emitting replies out of order. Cross-
      // session traffic stays parallel: distinct sessionIds get
      // distinct chains.
      const chains = new Map<string, Promise<unknown>>();
      const sttTimeoutMs = config.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
      const enqueue = (sessionId: string, utterance: Uint8Array): void => {
        const prev = chains.get(sessionId) ?? Promise.resolve();
        const next = prev
          .catch(() => undefined)
          .then(async () => {
            // Bounded STT — without this, a single hung transcribe()
            // (provider outage, network black-hole) would block every
            // subsequent utterance for this sessionId forever via the
            // chain, turning a transient hiccup into a persistent
            // one-way voice outage. On timeout the chain advances and
            // the dropped utterance is surfaced via onSttError so the
            // host can retry / page / reroute.
            // let requires justification: STT may throw, time out, or return null
            let text: string | null;
            // AbortController gives cooperative STT impls a way to
            // free provider resources / quota when our timeout fires.
            // Without this, a hung provider would accumulate one
            // abandoned transcription per utterance behind dropped
            // turns — wasting compute and hiding the real outage.
            const sttCtl = new AbortController();
            // Track the STT controller so disconnect aborts an in-flight
            // transcription instead of leaving it to burn provider quota
            // until the upstream timeout. Removed in finally so completed
            // (or aborted) calls don't keep the controller live.
            inflightControllers.add(sttCtl);
            try {
              const transcribePromise = config.stt.transcribe(utterance, sttCtl.signal);
              // let requires justification: handle assigned conditionally for cleanup
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  // Defer abort so Promise.race surfaces the typed
                  // VoiceSttTimeoutError, not the cooperative impl's
                  // downstream "aborted" rejection.
                  queueMicrotask(() => sttCtl.abort());
                  reject(new VoiceSttTimeoutError(sttTimeoutMs));
                }, sttTimeoutMs);
              });
              try {
                text = await Promise.race([transcribePromise, timeoutPromise]);
              } finally {
                if (timer !== undefined) clearTimeout(timer);
                inflightControllers.delete(sttCtl);
              }
            } catch (err) {
              (config.onSttError ?? defaultSttErrorLogger)(err, utterance);
              return;
            }
            // Enter the per-turn ALS ONCE for this utterance. All
            // registered onMessage handlers are dispatched concurrently
            // by channel-base inside this scope, so they share the same
            // {gen, turnToken, collector}. The wrapped onMessage below
            // pushes its handler-result Promise into collector.promises
            // synchronously, so by the time `handler(...)` returns we
            // have the full set of in-flight handler promises for this
            // turn — not just the last-registered one.
            const turnToken: object = {};
            const collector: { readonly promises: Promise<unknown>[] } = { promises: [] };
            const capturedGen = connectGen;
            // Per-turn nonce. Round-47 high: do NOT auto-expire the prior
            // turn just because a new utterance arrived for the same
            // sessionId — that drops legitimate slow tool/model replies
            // (turn A's tool-call finishes after the user starts turn B).
            // Turn invalidation is now driven only by the dispatch
            // watchdog (handler hung past dispatchHandlerTimeoutMs) — an
            // explicit, time-bound signal rather than implicit barge-in.
            // Hosts wanting strict barge-in semantics or sessionId-reuse
            // safety should mint a unique sessionId per logical call (the
            // documented transport contract); the adapter cannot infer
            // call boundaries from utterance ordering alone.
            const turnId = randomBytes(16).toString("hex");
            // Round-51 high: a fresh inbound establishes a new
            // incarnation — clear the post-endCall untagged-send fence.
            sessionsAwaitingNewTurn.delete(sessionId);
            const stampedSessionGen = getSessionGen(sessionId);
            inboundGenContext.run(
              {
                gen: capturedGen,
                turnToken,
                turnId,
                sessionId,
                sessionGen: stampedSessionGen,
                collector,
              },
              () => {
                handler({ sessionId, utterance, text });
              },
            );
            if (collector.promises.length > 0) {
              // Bounded wait: a hung handler must not wedge later
              // utterances on the same session forever. On timeout we
              // surrender ordering for the next utterance AND fence the
              // stuck turn's future sends — without that fence a
              // late-resolving handler would inject audio out of order
              // into the now-current turn for the same session.
              const watchdogMs =
                config.dispatchHandlerTimeoutMs ?? DEFAULT_DISPATCH_HANDLER_TIMEOUT_MS;
              // let requires justification: timer ref captured for cleanup
              let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
              const watchdog = new Promise<"watchdog">((resolve) => {
                watchdogTimer = setTimeout(() => resolve("watchdog"), watchdogMs);
              });
              try {
                const outcome = await Promise.race([
                  Promise.allSettled(collector.promises).then(() => "settled" as const),
                  watchdog,
                ]);
                if (outcome === "watchdog") {
                  expiredTurnTokens.add(turnToken);
                  // Round-52 high: bump the per-session call generation
                  // so any detached reply carrying a stamped session-gen
                  // less than the new value is rejected. Replaces the
                  // FIFO turn-id tombstone (which silently lost safety
                  // state on busy adapters).
                  bumpSessionGen(sessionId);
                }
              } finally {
                if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
              }
            }
          });
        chains.set(sessionId, next);
        // Drop the chain entry once the tail settles so long-lived
        // adapters don't accumulate a Map entry per call leg forever.
        next.finally(() => {
          if (chains.get(sessionId) === next) chains.delete(sessionId);
        });
      };
      // Wire the live sink so future utterances flow through the chain.
      rawUtteranceSink = enqueue;
      // Drain anything that arrived between transport.connect() and now.
      // Order is preserved: per-session chain serialization in enqueue()
      // ensures buffered turn N is dispatched before live turn N+1.
      const drain = pendingUtterances;
      pendingUtterances = [];
      for (const item of drain) enqueue(item.sessionId, item.utterance);
      return () => {
        rawUtteranceSink = undefined;
      };
    },
    normalize: (event: TransportEvent): InboundMessage | null => {
      // Fail fast at the trust boundary: a blank sessionId would let the
      // runtime process a turn it can never reply to (outbound throws
      // VoiceMissingSessionError), producing one-way conversations.
      // Throwing routes through onNormalizationError → onSttError so the
      // transport bug surfaces on ingress instead of every later reply.
      if (typeof event.sessionId !== "string" || event.sessionId.trim().length === 0) {
        throw new Error(
          "@koi/channel-voice: transport delivered an utterance with empty sessionId; per-session routing is required",
        );
      }
      if (event.text === null) return null;
      const trimmed = event.text.trim();
      if (trimmed.length === 0) return null;
      // Read the per-turn id and session-gen from ALS (set by enqueue
      // before handler runs) so they travel on the inbound metadata.
      const ctx = inboundGenContext.getStore();
      const turnIdMeta = ctx?.turnId;
      const sessionGenMeta = ctx?.sessionGen;
      const metadata: Record<string, unknown> = { [VOICE_CALL_EPOCH_KEY]: connectGen };
      if (typeof turnIdMeta === "string" && turnIdMeta.length > 0) {
        metadata[VOICE_TURN_ID_KEY] = turnIdMeta;
      }
      if (typeof sessionGenMeta === "number") {
        metadata[VOICE_SESSION_GEN_KEY] = sessionGenMeta;
      }
      return {
        content: [{ kind: "text", text: trimmed }],
        senderId,
        // Surface the transport sessionId as threadId so handler routing
        // (and replyToInbound-style helpers) keep replies on the right call.
        threadId: event.sessionId,
        timestamp: Date.now(),
        // Stamp the connect generation AND the per-turn id so detached
        // replies (handlers that captured the inbound, returned, then
        // resumed outside ALS) can still prove they belong to the
        // specific TURN that produced them — not just to the connection.
        metadata,
      };
    },
  });

  // Per-`threadId` outbound serialization. Each session gets its own
  // promise chain so a stuck TTS / stalled transport for caller A cannot
  // block caller B's reply. TTS synthesize and transport.sendUtterance
  // are both bounded by timeouts so a wedged provider cannot stall the
  // chain forever — the per-session chain advances via rejection.
  const sessionSendChains = new Map<string, Promise<void>>();
  // Generation counter incremented on every connect(). Used to scope
  // poison + send admission to the current connection — stale state
  // from a prior connection cannot block sends on the new one.
  // let requires justification: monotonic counter ticked by connect()
  let connectGen = 0;
  // Set of threadIds permanently poisoned for this adapter's lifetime.
  // A non-cooperative transport that ignores AbortSignal could still
  // surface audio after reconnect, so we keep the threadId blocked to
  // prevent overlap with newer audio on the same logical session.
  // Hosts using unique threadIds per call are unaffected; hosts using
  // stable/reused threadIds (the documented `"default"` pattern) MUST
  // construct a fresh adapter to recover after a transport timeout.
  const poisonedSessions = new Set<string>();
  // All AbortControllers for in-flight TTS/transport calls. disconnect()
  // aborts every one to give cooperative impls a chance to fence cleanly
  // before the channel reports recovery.
  const inflightControllers = new Set<AbortController>();
  // Raw, un-timeout-wrapped underlying TTS/transport promises. The
  // sessionSendChains map holds timeout-wrapped promises that already
  // settle on timer expiry — those don't tell us when the underlying
  // call actually finishes. To safely clear poison on disconnect we
  // must wait for the REAL promises to settle (cooperative impls
  // honor abort and reject promptly; non-cooperative impls hold the
  // disconnect open until the bounded fence below trips).
  const inflightRawOps = new Set<Promise<unknown>>();
  // Hard fence on how long disconnect waits for un-aborted underlying
  // ops to settle. After this expires, poison stays set for any
  // sessions that haven't been cleared by their controllers landing —
  // honest about non-cooperative transport risk. Default 2 s.
  const DISCONNECT_FENCE_TIMEOUT_MS = 2_000;
  const ttsTimeoutMs = config.ttsTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const transportSendTimeoutMs = config.transportSendTimeoutMs ?? DEFAULT_TRANSPORT_SEND_TIMEOUT_MS;

  // let requires justification: lifecycle gate flipped by connect/disconnect
  let voiceConnected = false;

  const performSend = async (
    sessionId: string,
    utteranceId: string,
    pieces: readonly string[],
  ): Promise<void> => {
    // Two-phase atomic delivery: synthesize ALL pieces first, then hand
    // the complete ordered frame sequence to the transport. A TTS failure
    // mid-sequence plays nothing rather than half a sentence.
    //
    // Timeout poisoning: if either TTS or the transport send times out,
    // the outer promise rejects but the underlying tts.synthesize() /
    // transport.sendUtterance() call cannot be cancelled and may still
    // complete later. To prevent that stale audio from playing AFTER
    // newer audio (broken ordering) or alongside a retry (overlapping
    // playback), we mark the session poisoned so subsequent sends on
    // the same threadId fail-fast until the host disconnects.
    // AbortController gives cooperative TTS / transport implementations
    // a chance to free resources and reject promptly when our timeout
    // fires. Non-cooperative impls cannot be force-cancelled — that's
    // why we ALSO poison the session below: future sends on the same
    // threadId fail-fast (within this connection), and disconnect does
    // NOT clear the poison so even after a reconnect a stale call that
    // eventually surfaces cannot be reordered with new audio on the
    // same threadId. Full recovery requires creating a fresh adapter.
    const ttsCtl = new AbortController();
    const sendCtl = new AbortController();
    inflightControllers.add(ttsCtl);
    inflightControllers.add(sendCtl);
    try {
      const frames: Uint8Array[] = [];
      // Defer abort() to a microtask AFTER returning the timeout error so
      // Promise.race surfaces the typed timeout error to the caller, not
      // the cooperative impl's downstream "aborted" rejection. The
      // underlying call still gets the abort signal — just one tick later,
      // which is irrelevant for cleanup but critical for the caller's
      // ability to discriminate timeout from arbitrary failure.
      for (const piece of pieces) {
        const rawTts = Promise.resolve(config.tts.synthesize(piece, ttsCtl.signal));
        // Track the RAW underlying promise so disconnect() can fence
        // on actual settlement, not the timeout wrapper's settlement.
        const tracked = rawTts.catch(() => undefined);
        inflightRawOps.add(tracked);
        tracked.finally(() => inflightRawOps.delete(tracked));
        const audio = await withTimeout(rawTts, ttsTimeoutMs, () => {
          queueMicrotask(() => ttsCtl.abort());
          return new VoiceTtsTimeoutError(ttsTimeoutMs, utteranceId, sessionId);
        });
        frames.push(audio);
      }
      const rawSend = Promise.resolve(
        config.transport.sendUtterance(sessionId, utteranceId, frames, sendCtl.signal),
      );
      const trackedSend = rawSend.catch(() => undefined);
      inflightRawOps.add(trackedSend);
      trackedSend.finally(() => inflightRawOps.delete(trackedSend));
      await withTimeout(rawSend, transportSendTimeoutMs, () => {
        queueMicrotask(() => sendCtl.abort());
        return new VoiceTransportSendTimeoutError(transportSendTimeoutMs, utteranceId, sessionId);
      });
    } catch (e: unknown) {
      // Only TRANSPORT timeouts get persistent poison: by the time we
      // call transport.sendUtterance(), some bytes may have already
      // been emitted and a stale resume could overlap newer audio on
      // the same threadId. TTS timeouts happen BEFORE transport ever
      // sees the frames, so no audio is on the wire — the failed
      // utterance leaves no trace. Don't brick the threadId for what
      // was effectively a no-op. (The session-poisoned-by-TTS-timeout
      // case used to brick stable `"default"` threadIds permanently
      // for what amounted to a transient provider hang.)
      if (e instanceof VoiceTransportSendTimeoutError) {
        poisonedSessions.add(sessionId);
      }
      throw e;
    } finally {
      inflightControllers.delete(ttsCtl);
      inflightControllers.delete(sendCtl);
    }
  };

  const wrappedSend = (message: OutboundMessage): Promise<void> => {
    if (!voiceConnected) {
      return Promise.reject(new Error('Channel "voice" is not connected'));
    }
    if (message.threadId === undefined || message.threadId.length === 0) {
      return Promise.reject(new VoiceMissingSessionError());
    }
    // Cross-generation send guard: if this send is being issued from a
    // host handler that started in a prior connection generation and
    // awaited across disconnect/reconnect, reject it. Without this,
    // a stale handler could speak a reply from an old call into a
    // newly reconnected one on the same reused threadId.
    const inboundCtx = inboundGenContext.getStore();
    if (inboundCtx !== undefined && inboundCtx.gen !== connectGen) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Per-turn fence: this handler ran past the dispatch watchdog and
    // the next utterance for the same session has already been admitted.
    // A late send from this turn would inject audio out of order into
    // (or overlap) the now-current turn — reject it instead of speaking.
    if (inboundCtx !== undefined && expiredTurnTokens.has(inboundCtx.turnToken)) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Detached-reply fence: ALS context can be lost across boundaries
    // the host doesn't control (queueMicrotask, setTimeout, third-party
    // promise libraries, worker dispatch, deferred queues). For those
    // cases the epoch must travel on the message itself — the adapter
    // stamps every inbound with `metadata.voiceCallEpoch`, and either
    // `replyToVoiceInbound()` or manual metadata propagation carries
    // it to the outbound. If the tag is present it MUST match the
    // current connectGen; if it is absent AND the adapter has ever
    // disconnected, the send is rejected. This protects against
    // cross-call leakage when a host reuses a stable threadId across
    // reconnects (e.g. `"default"`).
    const messageEpochRaw = message.metadata?.[VOICE_CALL_EPOCH_KEY];
    if (typeof messageEpochRaw === "number") {
      if (messageEpochRaw !== connectGen) {
        return Promise.reject(new VoicePoisonedSessionError(message.threadId));
      }
    } else if (inboundCtx === undefined && connectGen > 0) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Round-51/54 high: hard call boundary. After endCall(sessionId),
    // ALL sends to that threadId reject until a new inbound turn
    // establishes a fresh incarnation. Round-54 caught a bypass: the
    // round-51 check excused sends carrying epoch+sessionGen metadata,
    // which let `stampForCurrentCall(sessionId, ...)` AFTER endCall mint
    // a fresh stamp at the new generation and slip through. Now the
    // boundary is a hard deny regardless of stamped metadata — once the
    // host declares the call ended, nothing speaks into it until the
    // next user turn arrives.
    if (sessionsAwaitingNewTurn.has(message.threadId)) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Round-52 high: per-session call-generation fence (durable, no
    // FIFO eviction). Rejects any detached reply whose stamped session
    // gen is less than the session's current gen — bumped by the
    // watchdog (handler hung past dispatch timeout) or by endCall().
    // Replaces the round-43 turn-id-tombstone mechanism that silently
    // lost safety state after 1024 newer expirations.
    const messageSessionGenRaw = message.metadata?.[VOICE_SESSION_GEN_KEY];
    if (
      typeof messageSessionGenRaw === "number" &&
      messageSessionGenRaw < getSessionGen(message.threadId)
    ) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Round-46 high: origin-thread fence. A reply tagged via
    // replyToVoiceInbound() carries `voiceOriginThreadId` — the inbound's
    // session it was built from. If a caller (or buggy middleware) mutated
    // `message.threadId` to point at a DIFFERENT live call, reject — that
    // is a cross-call data leak (concurrent calls A and B; reply built
    // from A's inbound redirected to B by changing threadId).
    const originThreadRaw = message.metadata?.[VOICE_ORIGIN_THREAD_KEY];
    if (
      typeof originThreadRaw === "string" &&
      originThreadRaw.length > 0 &&
      originThreadRaw !== message.threadId
    ) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Poison persists for the adapter's lifetime once set. A non-
    // cooperative transport's stale call can still surface audio
    // later, so we MUST NOT admit a new send on the same threadId
    // even after reconnect — overlap would mix prior-call and
    // current-call audio. Recovery for stable/reused threadIds
    // requires constructing a fresh adapter; hosts using unique
    // threadIds per call (most realistic web/mobile patterns) are
    // unaffected.
    if (poisonedSessions.has(message.threadId)) {
      return Promise.reject(new VoicePoisonedSessionError(message.threadId));
    }
    // Pre-render rich blocks → text so non-text content (image alt, file
    // names, button labels) survives the wire as spoken text. channel-
    // base's renderBlocks pass is bypassed entirely now that this wrapper
    // owns the outbound path.
    const pieces: string[] = [];
    for (const block of message.content) {
      const text = renderBlockToSpokenText(block);
      for (const piece of chunk(text, maxTtsChars)) pieces.push(piece);
    }
    const sessionId = message.threadId;
    // utteranceId is the transport-level dedup key. Callers that retry
    // a logical outbound MUST pass a stable id via
    // `message.metadata.utteranceId` so the transport can suppress
    // double-playback. We only mint a fresh id when the caller did not
    // supply one (first attempt for that logical outbound).
    const suppliedId = message.metadata?.["utteranceId"];
    const utteranceId =
      typeof suppliedId === "string" && suppliedId.length > 0
        ? suppliedId
        : randomBytes(16).toString("hex");
    const prev = sessionSendChains.get(sessionId) ?? Promise.resolve();
    // Capture the generation at queue time. If this op sits behind a
    // hung `prev` and disconnect/reconnect happens before `prev`
    // settles, queuedGen will not match the new connectGen — refuse
    // to execute a pre-disconnect queue entry against the new
    // connection so stale TTS/transport work cannot leak into a
    // recovered session. .catch on prev swallows prior failures so a
    // single bad turn doesn't poison every later turn for the same
    // session.
    const queuedGen = connectGen;
    const op = prev
      .catch(() => undefined)
      .then(() => {
        if (connectGen !== queuedGen) {
          return Promise.reject(new VoicePoisonedSessionError(sessionId));
        }
        // Round-45 high: re-check poison BEFORE running performSend. The
        // upfront check at wrappedSend entry runs only at queue-admission
        // time. If send A times out (poisoning sessionId) while send B is
        // already queued behind A, the queued continuation must NOT
        // execute B against the now-poisoned session — otherwise B speaks
        // and then A's late completion arrives, causing reordered or
        // overlapping audio. Reject queued sends for poisoned sessions
        // here so the contract holds for the entire chain, not just the
        // entry path.
        if (poisonedSessions.has(sessionId)) {
          return Promise.reject(new VoicePoisonedSessionError(sessionId));
        }
        return performSend(sessionId, utteranceId, pieces);
      });
    // Store a swallowed copy as the chain head. The caller still awaits
    // the rejecting `op` directly; the Map entry must not be a rejecting
    // promise or it would surface as an unhandled rejection when the
    // tail-cleanup .then runs.
    const tracked = op.catch(() => undefined);
    sessionSendChains.set(sessionId, tracked);
    tracked.then(() => {
      // Release the Map entry once this op is the chain's tail, so
      // long-lived adapters don't accumulate one entry per call leg.
      if (sessionSendChains.get(sessionId) === tracked) {
        sessionSendChains.delete(sessionId);
      }
    });
    return op;
  };

  return {
    name: inner.name,
    capabilities: inner.capabilities,
    connect: async (): Promise<void> => {
      await inner.connect();
      voiceConnected = true;
    },
    disconnect: async (): Promise<void> => {
      voiceConnected = false;
      // Quiesce ingress IMMEDIATELY: any further utterances arriving
      // during the fence window from transport.onUtterance must be
      // dropped, not fed into STT/dispatch. Without this, a stale
      // user turn could still trigger model+tool work AFTER the host
      // started disconnect — defeating shutdown/failover ordering.
      // Clearing the sink makes the inbound thunk a no-op (the
      // pendingUtterances bound is also dropped so we don't replay
      // them on a next connect).
      rawUtteranceSink = undefined;
      pendingUtterances = [];
      // (Per-turn collectors live on the stack inside the STT chain's
      // .then(); they are released as each turn completes or its
      // watchdog fires. No global per-session map to clear here.)
      // Drain in-flight per-session sends before tearing down transport
      // so partial frames don't fly into a closing call. Failures are
      // swallowed — they were already surfaced to their callers.
      // Bump the generation FIRST so any send queued in
      // sessionSendChains (waiting behind a hung op) will see the
      // mismatch when its `prev.then(() => performSend(...))` finally
      // runs and reject with VoicePoisonedSessionError instead of
      // executing performSend against a torn-down channel. Without
      // this, a queued send could synthesize TTS and call
      // transport.sendUtterance() AFTER disconnect completes.
      connectGen++;
      // Round-52 medium: per-session state is connection-scoped — clear
      // it on disconnect so long-lived adapters don't accumulate per-
      // sessionId entries indefinitely. The connection-epoch fence
      // (connectGen++) handles cross-disconnect detached replies.
      sessionCallGen.clear();
      sessionsAwaitingNewTurn.clear();
      // Abort every in-flight TTS / transport call. Cooperative impls
      // reject promptly; non-cooperative impls may keep running, but
      // their results land in this (now-dead) generation.
      for (const ctl of inflightControllers) ctl.abort();
      sessionSendChains.clear();
      // Bounded best-effort fence on raw ops so cooperative impls get
      // a chance to settle before we tear down the transport.
      const rawOps = [...inflightRawOps];
      // let requires justification: tracks fence outcome for poison clear
      let fenceCleanlyCompleted = rawOps.length === 0;
      if (rawOps.length > 0) {
        const fenceSettled = Promise.allSettled(rawOps).then(() => "settled" as const);
        const fenceTimedOut = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), DISCONNECT_FENCE_TIMEOUT_MS);
        });
        const outcome = await Promise.race([fenceSettled, fenceTimedOut]);
        fenceCleanlyCompleted = outcome === "settled";
      }
      // Recover poisoned sessions only when we proved no stale raw op
      // can still surface audio. Cooperative transports (honoring the
      // AbortSignal forwarded by performSend) settle inside the fence
      // window; non-cooperative ones leave raw ops running, in which
      // case poison persists for the adapter's lifetime so a stale
      // late frame cannot interleave with a fresh post-reconnect call.
      if (fenceCleanlyCompleted) {
        poisonedSessions.clear();
      }
      await inner.disconnect();
    },
    send: wrappedSend,
    // Wrap onMessage so the host handler runs INSIDE the per-turn ALS
    // (entered by the STT chain) and its returned Promise is added to
    // the per-turn collector. The collector aggregates promises from
    // ALL registered handlers for one inbound, so the watchdog fences
    // every handler's turn token together — not just the
    // last-registered one. This is the multi-handler safety property
    // (round 34): two async handlers, the first hangs past the
    // watchdog, the second turn runs, the first handler's late
    // ch.send() must still be rejected.
    onMessage: (handler: import("@koi/core").MessageHandler): (() => void) =>
      inner.onMessage((msg) => {
        const ctx = inboundGenContext.getStore();
        const result = handler(msg);
        if (ctx?.collector !== undefined && result instanceof Promise) {
          ctx.collector.promises.push(result);
        }
        return result;
      }),
    // Round-40 high: legitimate server-initiated outbound (welcome
    // prompt after reconnect, externally-triggered prompt, queued work
    // resumed after reconnect) has no inbound to copy the epoch from
    // and lives outside any ALS scope. Without a public API to mint
    // the current-generation tag, the wrappedSend post-reconnect fence
    // would treat every such send as stale. `stampForCurrentCall`
    // returns a clone of the outbound with the live `connectGen`
    // stamped into metadata — the only supported way for hosts to
    // produce a current-call outbound that survives the fence.
    stampForCurrentCall: (sessionId: string, outbound: OutboundMessage): OutboundMessage => ({
      ...outbound,
      // Force-route to the named session — a stamped outbound that
      // accidentally carried a different threadId would still be
      // rejected by wrappedSend's origin-thread fence, but pinning
      // threadId here makes the safe path the only path.
      threadId: sessionId,
      metadata: {
        ...(outbound.metadata ?? {}),
        [VOICE_CALL_EPOCH_KEY]: connectGen,
        [VOICE_SESSION_GEN_KEY]: getSessionGen(sessionId),
        [VOICE_ORIGIN_THREAD_KEY]: sessionId,
      },
    }),
    /** Read-only view of the current call epoch for hosts that prefer to stamp manually. */
    currentCallEpoch: (): number => connectGen,
    endCall: (sessionId: string): void => {
      // Round-52 high: bump the durable session call generation. Every
      // inbound for this session was stamped with the OLD gen, so all
      // pending tagged replies (single-turn or multi-turn) become stale
      // by exactly one bump — no need to track individual turn ids.
      bumpSessionGen(sessionId);
      // Round-51 high: hard call boundary — ALSO block untagged sends
      // to this threadId until a NEW inbound establishes a fresh
      // incarnation. Without this an old-call callback's bare
      // `ch.send({threadId:...})` (no metadata) would still admit.
      sessionsAwaitingNewTurn.add(sessionId);
    },
  } satisfies VoiceChannelAdapter;
}
