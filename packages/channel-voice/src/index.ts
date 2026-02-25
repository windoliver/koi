/**
 * @koi/channel-voice — LiveKit WebRTC + STT/TTS voice channel adapter (L2).
 *
 * Bridges real-time voice I/O (via LiveKit) into Koi's message-based channel
 * contract. Users speak, speech is transcribed (STT), the engine processes
 * text, and the response is synthesized back to speech (TTS).
 */

// Config types + validation
export type { SttConfig, TtsConfig, VoiceChannelConfig } from "./config.js";
export {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_ROOM_EMPTY_TIMEOUT_SECONDS,
  validateVoiceConfig,
} from "./config.js";
// Pipeline interface (for testing/extension)
export type { TranscriptEvent, VoicePipeline } from "./pipeline.js";
export type { VoiceSession } from "./room.js";
// Adapter types
export type { VoiceChannelAdapter } from "./voice-channel.js";
// Factory
export { createVoiceChannel } from "./voice-channel.js";
