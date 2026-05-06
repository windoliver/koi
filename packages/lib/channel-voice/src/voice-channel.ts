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
 * sessions through one adapter without cross-talk. Transports that only
 * ever serve a single concurrent session may pass a constant string (e.g.
 * `"default"`) — but the field is REQUIRED so the contract cannot silently
 * collapse two callers into one conversation.
 *
 * **Inbound contract:** `onUtterance` MUST deliver complete utterance
 * buffers (upstream voice-activity-detected / endpointed). The voice
 * channel calls `stt.transcribe()` once per emitted buffer; emitting
 * per-packet would fragment transcripts and explode STT cost.
 *
 * **Outbound contract:** `sendUtterance` is invoked with the FULL ordered
 * sequence of audio frames for one reply, atomically. The transport is
 * responsible for either delivering the entire utterance or surfacing a
 * single failure that leaves the user-audible state in a defined position
 * (so the caller can retry idempotently). The channel does NOT stream
 * chunk-by-chunk and does NOT supply resume tokens — atomicity is the
 * transport's responsibility.
 */
export interface VoiceTransport {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly sendUtterance: (sessionId: string, frames: readonly Uint8Array[]) => Promise<void>;
  readonly onUtterance: (handler: (sessionId: string, utterance: Uint8Array) => void) => () => void;
}

/** Speech-to-text. Returning `null` skips dispatch (e.g., silence/no speech detected). */
export interface Stt {
  readonly transcribe: (audio: Uint8Array) => Promise<string | null>;
}

/** Text-to-speech. Returns the encoded audio buffer to hand to the transport. */
export interface Tts {
  readonly synthesize: (text: string) => Promise<Uint8Array>;
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

const DEFAULT_STT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSPORT_SEND_TIMEOUT_MS = 30_000;

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

  const inner = createChannelAdapter<TransportEvent>({
    name: "voice",
    capabilities: VOICE_CAPABILITIES,
    onNormalizationError: (err: unknown, event: TransportEvent) =>
      (config.onSttError ?? defaultSttErrorLogger)(err, event.utterance),
    platformConnect: () => config.transport.connect(),
    platformDisconnect: () => config.transport.disconnect(),
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
      // Per-session STT serialization. Without this chain, two utterances
      // arriving back-to-back on the same call leg both start STT in
      // parallel; if turn 2's transcribe resolves first (faster speech /
      // smaller buffer / different STT shard), the runtime sees
      // "B then A" and the dialogue scrambles. Chaining each utterance's
      // STT after the prior one for that sessionId guarantees in-order
      // dispatch per call. Cross-session traffic stays parallel — distinct
      // sessionIds get distinct chains, so a slow caller can't head-of-
      // line block other callers' turns.
      const chains = new Map<string, Promise<unknown>>();
      const sttTimeoutMs = config.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
      return config.transport.onUtterance((sessionId, utterance) => {
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
            try {
              const transcribePromise = config.stt.transcribe(utterance);
              // let requires justification: handle assigned conditionally for cleanup
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new VoiceSttTimeoutError(sttTimeoutMs)),
                  sttTimeoutMs,
                );
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
            handler({ sessionId, utterance, text });
          });
        chains.set(sessionId, next);
        // Drop the chain entry once the tail settles so long-lived
        // adapters don't accumulate a Map entry per call leg forever.
        next.finally(() => {
          if (chains.get(sessionId) === next) chains.delete(sessionId);
        });
      });
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
  const ttsTimeoutMs = config.ttsTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const transportSendTimeoutMs = config.transportSendTimeoutMs ?? DEFAULT_TRANSPORT_SEND_TIMEOUT_MS;

  // let requires justification: lifecycle gate flipped by connect/disconnect
  let voiceConnected = false;

  const performSend = async (sessionId: string, pieces: readonly string[]): Promise<void> => {
    // Two-phase atomic delivery: synthesize ALL pieces first, then hand
    // the complete ordered frame sequence to the transport. A TTS failure
    // mid-sequence plays nothing rather than half a sentence.
    const frames: Uint8Array[] = [];
    for (const piece of pieces) {
      const audio = await withTimeout(
        Promise.resolve(config.tts.synthesize(piece)),
        ttsTimeoutMs,
        () => new VoiceTtsTimeoutError(ttsTimeoutMs),
      );
      frames.push(audio);
    }
    await withTimeout(
      Promise.resolve(config.transport.sendUtterance(sessionId, frames)),
      transportSendTimeoutMs,
      () => new VoiceTransportSendTimeoutError(transportSendTimeoutMs),
    );
  };

  const wrappedSend = (message: OutboundMessage): Promise<void> => {
    if (!voiceConnected) {
      return Promise.reject(new Error('Channel "voice" is not connected'));
    }
    if (message.threadId === undefined || message.threadId.length === 0) {
      return Promise.reject(new VoiceMissingSessionError());
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
    const prev = sessionSendChains.get(sessionId) ?? Promise.resolve();
    // .catch on prev swallows prior failures so a single bad turn doesn't
    // poison every later turn for the same session — the chain advances
    // and the next caller gets a fresh attempt.
    const op = prev.catch(() => undefined).then(() => performSend(sessionId, pieces));
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
      // Drain in-flight per-session sends before tearing down transport
      // so partial frames don't fly into a closing call. Failures are
      // swallowed — they were already surfaced to their callers.
      const inflight = [...sessionSendChains.values()];
      sessionSendChains.clear();
      await Promise.allSettled(inflight);
      await inner.disconnect();
    },
    send: wrappedSend,
    onMessage: inner.onMessage,
  };
}
