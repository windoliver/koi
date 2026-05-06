import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, OutboundMessage } from "@koi/core";

/** Audio I/O transport for the voice channel. Vendor wiring (LiveKit etc.) lives here. */
export interface VoiceTransport {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly sendAudio: (frame: Uint8Array) => Promise<void>;
  /** Subscribe to inbound audio frames. Returns an unsubscribe function. */
  readonly onAudio: (handler: (frame: Uint8Array) => void) => () => void;
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

const VOICE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: true,
  video: false,
  threads: false,
  supportsA2ui: false,
};

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

  return createChannelAdapter<Uint8Array>({
    name: "voice",
    capabilities: VOICE_CAPABILITIES,
    onNormalizationError: config.onSttError ?? defaultSttErrorLogger,
    platformConnect: () => config.transport.connect(),
    platformDisconnect: () => config.transport.disconnect(),
    platformSend: async (message: OutboundMessage) => {
      // Two-phase delivery to make mid-response failure recoverable:
      //   Phase 1: synthesize EVERY chunk to audio. If any synth call rejects,
      //            the user has heard nothing yet and the caller can retry the
      //            whole utterance idempotently.
      //   Phase 2: stream the prepared frames to the transport in order. A
      //            transport failure mid-utterance is still user-visible, but
      //            the synth phase having succeeded means the frames are
      //            cached and a transport-level resume is possible without
      //            re-running TTS.
      // Without this split, a TTS failure on chunk N would leave chunks 0..N-1
      // already spoken with no idempotent retry path.
      const pieces: string[] = [];
      for (const block of message.content) {
        const text =
          block.kind === "text"
            ? block.text
            : `[${block.kind}: ${block.kind === "custom" ? block.type : block.kind}]`;
        for (const piece of chunk(text, maxTtsChars)) pieces.push(piece);
      }
      const frames: Uint8Array[] = [];
      for (const piece of pieces) {
        frames.push(await config.tts.synthesize(piece));
      }
      for (const audio of frames) {
        await config.transport.sendAudio(audio);
      }
    },
    onPlatformEvent: (handler) => config.transport.onAudio(handler),
    normalize: async (frame) => {
      const text = await config.stt.transcribe(frame);
      if (text === null) return null;
      // Treat empty / whitespace-only transcripts as silence. Otherwise a
      // clipped audio frame, end-of-utterance marker, or degraded provider
      // response that returns "" would burn a full agent turn (and may even
      // produce a spoken response to silence).
      const trimmed = text.trim();
      if (trimmed.length === 0) return null;
      return {
        content: [{ kind: "text", text: trimmed }],
        senderId,
        timestamp: Date.now(),
      };
    },
  });
}
