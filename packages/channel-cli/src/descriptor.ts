/**
 * BrickDescriptor for @koi/channel-cli.
 *
 * Enables manifest auto-resolution for the CLI stdin/stdout channel.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { createCliChannel } from "./cli-channel.js";

function validateCliChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "CLI channel options must be an object",
        retryable: false,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for CLI channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-cli",
  aliases: ["cli"],
  optionsValidator: validateCliChannelOptions,
  factory(): ChannelAdapter {
    return createCliChannel();
  },
};
