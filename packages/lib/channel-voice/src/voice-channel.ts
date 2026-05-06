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
    platformSend: async (message: OutboundMessage) => {
      // Strict per-session routing: outbound MUST identify which call leg
      // it replies to, otherwise a host that fans multiple calls through
      // one adapter could cross-talk one caller's reply to another.
      if (message.threadId === undefined || message.threadId.length === 0) {
        throw new VoiceMissingSessionError();
      }
      // Atomic two-phase delivery:
      //   Phase 1: synthesize EVERY chunk so a TTS failure plays nothing.
      //   Phase 2: hand the entire ordered frame sequence to the transport
      //            atomically — the transport is responsible for either
      //            delivering the whole utterance or failing in a way that
      //            leaves user-audible state in a known position. The
      //            channel never streams chunk-by-chunk, so a partial
      //            playback / non-idempotent retry race lives at the
      //            transport boundary (where it can use codec sequence
      //            numbers / acks), not inside the channel.
      // By the time platformSend runs, the outer wrapper has already
      // collapsed every block to a `text` block via renderBlockToSpokenText,
      // so this loop only sees text. Chunking is per-text-block so very
      // long replies fit the TTS engine's input limits.
      const pieces: string[] = [];
      for (const block of message.content) {
        if (block.kind !== "text") continue;
        for (const piece of chunk(block.text, maxTtsChars)) pieces.push(piece);
      }
      const frames: Uint8Array[] = [];
      for (const piece of pieces) {
        frames.push(await config.tts.synthesize(piece));
      }
      await config.transport.sendUtterance(message.threadId, frames);
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
      return config.transport.onUtterance((sessionId, utterance) => {
        const prev = chains.get(sessionId) ?? Promise.resolve();
        const next = prev
          .catch(() => undefined)
          .then(async () => {
            // let requires justification: STT may throw or return null
            let text: string | null;
            try {
              text = await config.stt.transcribe(utterance);
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

  // Wrap send() to pre-render rich blocks → text BEFORE channel-base sees
  // them, so its capability-driven renderBlocks pass cannot lose semantics.
  return {
    ...inner,
    send: (message: OutboundMessage): Promise<void> =>
      inner.send({
        ...message,
        content: message.content.map(
          (block): ContentBlock => ({ kind: "text", text: renderBlockToSpokenText(block) }),
        ),
      }),
  };
}
