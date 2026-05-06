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
  constructor(timeoutMs: number) {
    super(`@koi/channel-voice: TTS synthesize exceeded ${String(timeoutMs)}ms`);
    this.name = "VoiceTtsTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown from `send()` when `transport.sendUtterance()` exceeds `transportSendTimeoutMs`. */
export class VoiceTransportSendTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`@koi/channel-voice: transport.sendUtterance exceeded ${String(timeoutMs)}ms`);
    this.name = "VoiceTransportSendTimeoutError";
    this.timeoutMs = timeoutMs;
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

export function createVoiceChannel(config: VoiceChannelConfig): ChannelAdapter {
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

  // ALS captures the connectGen at handler-entry time. wrappedSend
  // checks this on every send: if the host's handler awaited across
  // disconnect/reconnect and now calls send(), the captured gen will
  // not match the current connectGen and the stale reply is rejected
  // (preventing cross-session leak into a reused threadId).
  const inboundGenContext = new AsyncLocalStorage<{ readonly gen: number }>();

  // Per-session dispatch-completion tracker. The wrapped onMessage
  // below records every async handler invocation's promise here so the
  // STT chain (in onPlatformEvent) can await it before processing the
  // next utterance for the same sessionId. This extends the per-
  // session ordering guarantee from "STT serialized" to "full handler
  // pipeline serialized" — a host whose onMessage handler does multi-
  // second runtime work (model+tool calls) cannot have two same-session
  // turns running concurrently.
  const sessionDispatchInFlight = new Map<string, Promise<unknown>>();

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
              }
            } catch (err) {
              (config.onSttError ?? defaultSttErrorLogger)(err, utterance);
              return;
            }
            // Mark this session as "dispatch in flight" BEFORE handler()
            // synchronously enqueues the dispatch. The wrapped onMessage
            // (below) populates `sessionDispatchInFlight[sessionId]`
            // when each handler invocation returns a Promise. The STT
            // chain then awaits it so the NEXT utterance for this
            // session waits for all current handlers to finish. Cross-
            // session traffic remains parallel.
            handler({ sessionId, utterance, text });
            const inFlight = sessionDispatchInFlight.get(sessionId);
            if (inFlight !== undefined) {
              sessionDispatchInFlight.delete(sessionId);
              // Bounded wait: a hung handler must not wedge later
              // utterances on the same session forever. On timeout we
              // surrender ordering for the next utterance; the stuck
              // promise is left to settle on its own.
              const watchdogMs =
                config.dispatchHandlerTimeoutMs ?? DEFAULT_DISPATCH_HANDLER_TIMEOUT_MS;
              // let requires justification: timer ref captured for cleanup
              let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
              const watchdog = new Promise<"watchdog">((resolve) => {
                watchdogTimer = setTimeout(() => resolve("watchdog"), watchdogMs);
              });
              try {
                await Promise.race([inFlight.then(() => "settled" as const), watchdog]);
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
      return {
        content: [{ kind: "text", text: trimmed }],
        senderId,
        // Surface the transport sessionId as threadId so handler routing
        // (and replyToInbound-style helpers) keep replies on the right call.
        threadId: event.sessionId,
        timestamp: Date.now(),
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
          return new VoiceTtsTimeoutError(ttsTimeoutMs);
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
        return new VoiceTransportSendTimeoutError(transportSendTimeoutMs);
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
      // Drop stale per-session handler-completion promises so a hung
      // handler from this connection cannot block the next inbound
      // turn after reconnect. Without this, the next utterance for
      // a reused threadId would Promise.allSettled([prev, ...]) the
      // dead promise and wedge the chain indefinitely.
      sessionDispatchInFlight.clear();
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
      // Abort every in-flight TTS / transport call. Cooperative impls
      // reject promptly; non-cooperative impls may keep running, but
      // their results land in this (now-dead) generation.
      for (const ctl of inflightControllers) ctl.abort();
      sessionSendChains.clear();
      // Bounded best-effort fence on raw ops so cooperative impls get
      // a chance to settle before we tear down the transport. We do
      // NOT touch poisonedSessions here — generation invalidation on
      // the next connect handles recovery.
      const rawOps = [...inflightRawOps];
      if (rawOps.length > 0) {
        const fenceSettled = Promise.allSettled(rawOps).then(() => undefined);
        const fenceTimedOut = new Promise<void>((resolve) => {
          setTimeout(resolve, DISCONNECT_FENCE_TIMEOUT_MS);
        });
        await Promise.race([fenceSettled, fenceTimedOut]);
      }
      await inner.disconnect();
    },
    send: wrappedSend,
    // Wrap onMessage so each handler invocation that returns a Promise
    // gets recorded under sessionDispatchInFlight[threadId]. The STT
    // chain awaits these before processing the next utterance,
    // extending per-session ordering through the host's full handler
    // pipeline (not just STT).
    onMessage: (handler: import("@koi/core").MessageHandler): (() => void) =>
      inner.onMessage((msg) => {
        // Snapshot the connection generation at handler-entry time and
        // pin it into ALS for the duration of the handler chain. Any
        // wrappedSend() called from within (even after disconnect/
        // reconnect bumps connectGen) sees the captured value and
        // rejects if it no longer matches.
        const capturedGen = connectGen;
        const result = inboundGenContext.run({ gen: capturedGen }, () => handler(msg));
        const sid = msg.threadId;
        if (sid !== undefined && sid.length > 0 && result instanceof Promise) {
          // Compose with any existing in-flight promise for this
          // session — multiple handlers attached to the same session
          // should all complete before the next utterance dispatches.
          const prev = sessionDispatchInFlight.get(sid);
          const tracked = prev !== undefined ? Promise.allSettled([prev, result]) : result;
          sessionDispatchInFlight.set(
            sid,
            (tracked as Promise<unknown>).catch(() => undefined),
          );
        }
        return result;
      }),
  };
}
