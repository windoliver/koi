/**
 * @koi/channel-voice — LiveKit WebRTC + STT/TTS voice channel adapter.
 *
 * Creates a ChannelAdapter for real-time voice conversations. Audio is
 * transcribed via STT, the engine processes text, and responses are
 * synthesized back via TTS. The engine only sees TextBlocks — voice
 * encoding/decoding is fully internal.
 *
 * Usage:
 *   const adapter = createVoiceChannel({ livekitUrl: "wss://...", ... });
 *   await adapter.connect();
 *   const session = await adapter.createSession();
 *   // Give session.token + session.wsUrl to the client
 *
 * Extended interface: createSession() returns room credentials for the
 * client to join. activeRoom exposes the current room name (if any).
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from "@koi/core";
import type { RetryConfig } from "@koi/errors";
import { withRetry } from "@koi/errors";
import { chunkTtsInput } from "./chunk-tts-input.js";
import { DEFAULT_TTS_CHUNKING, type VoiceChannelConfig } from "./config.js";
import { normalizeTranscript } from "./normalize.js";
import type { TranscriptEvent, VoicePipeline } from "./pipeline.js";
import { createLiveKitPipeline } from "./pipeline.js";
import {
  createRoomManager,
  type RoomManager,
  type RoomService,
  type TokenGenerator,
  type VoiceSession,
} from "./room.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const VOICE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  audio: true,
  images: false,
  files: false,
  buttons: false,
  video: false,
  threads: false,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/** Tight retry config for TTS speak() — fast retries on transient failures. */
const SPEAK_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoffMultiplier: 2,
  initialDelayMs: 200,
  maxBackoffMs: 2_000,
  jitter: true,
} as const satisfies RetryConfig;

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

export interface VoiceChannelAdapter extends ChannelAdapter {
  /** Create a new voice session. Returns room credentials for the client. */
  readonly createSession: () => Promise<VoiceSession>;
  /** The room name of the most recently created session, or undefined. */
  readonly activeRoom: string | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceChannel(
  config: VoiceChannelConfig,
  overrides?: {
    readonly pipeline?: VoicePipeline;
    readonly roomService?: RoomService;
    readonly tokenGenerator?: TokenGenerator;
  },
): VoiceChannelAdapter {
  const pipeline = overrides?.pipeline ?? createLiveKitPipeline(config);
  const debug = config.debug ?? false;

  // Resolve TTS chunking config once at factory time
  const chunkingConfig =
    config.ttsChunking === false
      ? false
      : config.ttsChunking !== undefined
        ? { ...DEFAULT_TTS_CHUNKING, ...config.ttsChunking }
        : DEFAULT_TTS_CHUNKING;

  // let requires justification: room manager initialized on connect, used through lifecycle
  let roomManager: RoomManager | undefined;
  // let requires justification: tracks current room name, set by createSession
  let currentRoom: string | undefined;
  // let requires justification: platform event unsubscribe, acquired on connect
  let unsubTranscript: (() => void) | undefined;

  const base = createChannelAdapter<TranscriptEvent>({
    name: "voice",
    capabilities: VOICE_CAPABILITIES,

    platformConnect: async () => {
      roomManager = createRoomManager(config, {
        ...(overrides?.roomService !== undefined && { roomService: overrides.roomService }),
        ...(overrides?.tokenGenerator !== undefined && {
          tokenGenerator: overrides.tokenGenerator,
        }),
      });
      roomManager.startCleanupSweep();
    },

    platformDisconnect: async () => {
      if (unsubTranscript !== undefined) {
        unsubTranscript();
        unsubTranscript = undefined;
      }

      if (pipeline.isRunning()) {
        await pipeline.stop();
      }

      if (roomManager !== undefined) {
        roomManager.stopCleanupSweep();
        await roomManager.endAllSessions();
        roomManager = undefined;
      }

      currentRoom = undefined;
    },

    platformSend: async (message) => {
      // Extract text from TextBlock(s) — voice only supports text
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.kind === "text") {
          texts.push(block.text);
        }
      }

      if (texts.length === 0) {
        // Non-text blocks silently skipped — voice only supports text
        return;
      }

      const combined = texts.join("\n");

      if (chunkingConfig === false) {
        // Chunking disabled — original single-speak behavior
        await withRetry(() => pipeline.speak(combined), SPEAK_RETRY_CONFIG);
        return;
      }

      const chunks = chunkTtsInput(combined, chunkingConfig);
      for (const chunk of chunks) {
        await withRetry(() => pipeline.speak(chunk), SPEAK_RETRY_CONFIG);
      }
    },

    platformSendStatus: async (status: ChannelStatus) => {
      // Only "processing" emits an audio cue — prevents dead air while agent thinks
      if (status.kind === "processing" && pipeline.isRunning()) {
        const filler = status.detail ?? "one moment";
        await withRetry(() => pipeline.speak(filler), SPEAK_RETRY_CONFIG);
      }
      // "idle" and "error" are no-ops — voice stops naturally
    },

    onPlatformEvent: (handler) => {
      unsubTranscript = pipeline.onTranscript(handler);
      return () => {
        if (unsubTranscript !== undefined) {
          unsubTranscript();
          unsubTranscript = undefined;
        }
      };
    },

    normalize: (event: TranscriptEvent) => {
      return normalizeTranscript(event, currentRoom ?? "unknown", debug);
    },

    // exactOptionalPropertyTypes: only spread optional fields when defined
    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
    ...(config.queueWhenDisconnected !== undefined && {
      queueWhenDisconnected: config.queueWhenDisconnected,
    }),
  });

  const createSession = async (): Promise<VoiceSession> => {
    if (roomManager === undefined) {
      throw new Error("Voice channel not connected — call connect() first");
    }

    const result = await roomManager.createSession();
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    currentRoom = result.value.roomName;

    // Start pipeline for this room if not already running
    if (!pipeline.isRunning()) {
      await pipeline.start(result.value.roomName);
    }

    return result.value;
  };

  return {
    ...base,
    createSession,
    get activeRoom(): string | undefined {
      return currentRoom;
    },
  };
}
