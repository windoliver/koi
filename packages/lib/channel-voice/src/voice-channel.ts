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
}

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

  return createChannelAdapter<Uint8Array>({
    name: "voice",
    capabilities: VOICE_CAPABILITIES,
    platformConnect: () => config.transport.connect(),
    platformDisconnect: () => config.transport.disconnect(),
    platformSend: async (message: OutboundMessage) => {
      for (const block of message.content) {
        if (block.kind !== "text") continue;
        for (const piece of chunk(block.text, maxTtsChars)) {
          const audio = await config.tts.synthesize(piece);
          await config.transport.sendAudio(audio);
        }
      }
    },
    onPlatformEvent: (handler) => config.transport.onAudio(handler),
    normalize: async (frame) => {
      const text = await config.stt.transcribe(frame);
      if (text === null) return null;
      return {
        content: [{ kind: "text", text }],
        senderId,
        timestamp: Date.now(),
      };
    },
  });
}
