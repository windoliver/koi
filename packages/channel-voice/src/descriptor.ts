/**
 * BrickDescriptor for @koi/channel-voice.
 *
 * Enables manifest auto-resolution for the LiveKit voice channel.
 * Requires LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
 * environment variables plus STT/TTS provider configuration.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";

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
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Voice channel"),
  factory(): ChannelAdapter {
    throw new Error(
      "@koi/channel-voice requires LiveKit credentials and STT/TTS config. " +
        "Use createVoiceChannel(config) directly from the CLI.",
    );
  },
};
