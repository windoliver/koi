/**
 * @koi/channel-voice — Audio channel adapter (L2).
 *
 * Bridges abstract STT/TTS/transport into Koi's text-based channel contract.
 * Vendor SDKs (LiveKit, OpenAI Realtime, etc.) are injected by the host.
 */

export type { Stt, Tts, VoiceChannelConfig, VoiceTransport } from "./voice-channel.js";
export { createVoiceChannel, VoiceMissingSessionError } from "./voice-channel.js";
