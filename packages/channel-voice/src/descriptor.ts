/**
 * BrickDescriptor for @koi/channel-voice.
 *
 * Enables manifest auto-resolution for the LiveKit voice channel.
 * Requires LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
 * environment variables plus STT/TTS provider configuration.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";

function validateVoiceChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Voice channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for voice channel adapter.
 *
 * Note: The voice channel requires LiveKit credentials and STT/TTS
 * provider configuration that cannot be fully resolved from YAML alone.
 * The factory throws — the CLI must inject runtime dependencies after
 * resolution. This descriptor registers the name/alias so the resolver
 * can validate and locate it.
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-voice",
  aliases: ["voice"],
  optionsValidator: validateVoiceChannelOptions,
  factory(): ChannelAdapter {
    throw new Error(
      "@koi/channel-voice requires LiveKit credentials and STT/TTS config. " +
        "Use createVoiceChannel(config) directly from the CLI.",
    );
  },
};
