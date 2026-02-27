/**
 * BrickDescriptor for @koi/channel-chat-sdk.
 *
 * Enables manifest auto-resolution for the Chat SDK multi-platform
 * channel adapter. Each platform in the config gets its own ChannelAdapter.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateChatSdkChannelConfig } from "./config.js";
import { createChatSdkChannels } from "./create-chat-sdk-channels.js";

function validateChatSdkChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Chat SDK channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for Chat SDK multi-platform channel adapter.
 *
 * The factory returns the first channel adapter from the configured
 * platforms. For multiple platforms, use createChatSdkChannels() directly.
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-chat-sdk",
  aliases: ["chat-sdk"],
  optionsValidator: validateChatSdkChannelOptions,
  factory(options: unknown, _context: ResolutionContext): ChannelAdapter {
    const raw = (options ?? {}) as Record<string, unknown>;

    const configResult = validateChatSdkChannelConfig(raw);
    if (!configResult.ok) {
      throw new Error(configResult.error.message);
    }

    const adapters = createChatSdkChannels(configResult.value);
    const first = adapters[0];
    if (first === undefined) {
      throw new Error("No channel adapters created — check your platform configuration");
    }
    return first;
  },
};
