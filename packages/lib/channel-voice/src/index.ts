/**
 * @koi/channel-voice — Audio channel adapter (L2).
 *
 * Bridges abstract STT/TTS/transport into Koi's text-based channel contract.
 * Vendor SDKs (LiveKit, OpenAI Realtime, etc.) are injected by the host.
 */

export type {
  Stt,
  Tts,
  VoiceChannelAdapter,
  VoiceChannelConfig,
  VoiceTransport,
} from "./voice-channel.js";
export {
  createVoiceChannel,
  replyToVoiceInbound,
  VOICE_CALL_EPOCH_KEY,
  VOICE_ORIGIN_THREAD_KEY,
  VOICE_TURN_ID_KEY,
  VoiceMissingSessionError,
  VoicePoisonedSessionError,
  VoiceSttTimeoutError,
  VoiceTransportSendTimeoutError,
  VoiceTtsTimeoutError,
} from "./voice-channel.js";
