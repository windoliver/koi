/**
 * Voice channel configuration and validation.
 *
 * Validates LiveKit connection parameters, STT/TTS provider configs, and
 * concurrency limits. Returns a typed Result — never throws on invalid input.
 */

import type { InboundMessage } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

// ---------------------------------------------------------------------------
// STT / TTS provider configs (discriminated unions)
// ---------------------------------------------------------------------------

export type SttConfig =
  | {
      readonly provider: "deepgram";
      readonly apiKey: string;
      readonly language?: string;
      readonly model?: string;
    }
  | {
      readonly provider: "openai";
      readonly apiKey: string;
      readonly language?: string;
      readonly model?: string;
    };

export type TtsConfig =
  | {
      readonly provider: "openai";
      readonly apiKey: string;
      readonly voice?: string;
      readonly model?: string;
    }
  | {
      readonly provider: "deepgram";
      readonly apiKey: string;
      readonly voice?: string;
      readonly model?: string;
    };

// ---------------------------------------------------------------------------
// TTS chunking config
// ---------------------------------------------------------------------------

export interface TtsChunkingConfig {
  /** Minimum words before a chunk is emitted. Defaults to 3. */
  readonly minChunkWords?: number;
  /** Maximum characters per chunk. Defaults to 200. */
  readonly maxChunkChars?: number;
}

// ---------------------------------------------------------------------------
// Main config interface
// ---------------------------------------------------------------------------

export interface VoiceChannelConfig {
  /** LiveKit server WebSocket URL (e.g., wss://my-livekit.example.com). */
  readonly livekitUrl: string;
  /** LiveKit API key for room management and token generation. */
  readonly livekitApiKey: string;
  /** LiveKit API secret for signing access tokens. */
  readonly livekitApiSecret: string;
  /** Speech-to-text provider configuration. */
  readonly stt: SttConfig;
  /** Text-to-speech provider configuration. */
  readonly tts: TtsConfig;
  /** Maximum concurrent voice sessions. Defaults to 10. */
  readonly maxConcurrentSessions?: number;
  /** Seconds before an empty room is cleaned up. Defaults to 300 (5 min). */
  readonly roomEmptyTimeoutSeconds?: number;
  /** Enable debug latency metrics in InboundMessage metadata. */
  readonly debug?: boolean;
  /** Called when a registered message handler throws or rejects. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** When true, send() buffers while disconnected and flushes on connect(). */
  readonly queueWhenDisconnected?: boolean;
  /** TTS chunking config. Omit to use defaults. Set to false to disable. */
  readonly ttsChunking?: TtsChunkingConfig | false;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CONCURRENT_SESSIONS = 10;
export const DEFAULT_ROOM_EMPTY_TIMEOUT_SECONDS = 300;

export const DEFAULT_TTS_CHUNKING: Readonly<Required<TtsChunkingConfig>> = {
  minChunkWords: 3,
  maxChunkChars: 200,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validationError(message: string): Result<VoiceChannelConfig, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

const VALID_STT_PROVIDERS = new Set(["deepgram", "openai"]);
const VALID_TTS_PROVIDERS = new Set(["openai", "deepgram"]);

export function validateVoiceConfig(config: unknown): Result<VoiceChannelConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (typeof c.livekitUrl !== "string" || c.livekitUrl.length === 0) {
    return validationError("livekitUrl must be a non-empty string");
  }

  if (typeof c.livekitApiKey !== "string" || c.livekitApiKey.length === 0) {
    return validationError("livekitApiKey must be a non-empty string");
  }

  if (typeof c.livekitApiSecret !== "string" || c.livekitApiSecret.length === 0) {
    return validationError("livekitApiSecret must be a non-empty string");
  }

  // Validate STT config
  if (c.stt === null || c.stt === undefined || typeof c.stt !== "object") {
    return validationError("stt config must be a non-null object");
  }
  const stt = c.stt as Record<string, unknown>;
  if (typeof stt.provider !== "string" || !VALID_STT_PROVIDERS.has(stt.provider)) {
    return validationError(`stt.provider must be one of: ${[...VALID_STT_PROVIDERS].join(", ")}`);
  }
  if (typeof stt.apiKey !== "string" || stt.apiKey.length === 0) {
    return validationError("stt.apiKey must be a non-empty string");
  }

  // Validate TTS config
  if (c.tts === null || c.tts === undefined || typeof c.tts !== "object") {
    return validationError("tts config must be a non-null object");
  }
  const tts = c.tts as Record<string, unknown>;
  if (typeof tts.provider !== "string" || !VALID_TTS_PROVIDERS.has(tts.provider)) {
    return validationError(`tts.provider must be one of: ${[...VALID_TTS_PROVIDERS].join(", ")}`);
  }
  if (typeof tts.apiKey !== "string" || tts.apiKey.length === 0) {
    return validationError("tts.apiKey must be a non-empty string");
  }

  // Validate optional maxConcurrentSessions
  if (c.maxConcurrentSessions !== undefined) {
    if (typeof c.maxConcurrentSessions !== "number" || c.maxConcurrentSessions <= 0) {
      return validationError("maxConcurrentSessions must be a positive number");
    }
  }

  // Validate optional roomEmptyTimeoutSeconds
  if (c.roomEmptyTimeoutSeconds !== undefined) {
    if (typeof c.roomEmptyTimeoutSeconds !== "number" || c.roomEmptyTimeoutSeconds <= 0) {
      return validationError("roomEmptyTimeoutSeconds must be a positive number");
    }
  }

  return { ok: true, value: config as VoiceChannelConfig };
}
