/**
 * BrickDescriptor for @koi/channel-mobile.
 *
 * Enables manifest auto-resolution for the mobile WebSocket channel.
 * Port is read from options or defaults to 8080.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { DEFAULT_MOBILE_PORT } from "./config.js";
import { createMobileChannel } from "./mobile-channel.js";

function validateMobileChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Mobile channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for mobile channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-mobile",
  aliases: ["mobile"],
  optionsValidator: validateMobileChannelOptions,
  factory(options, _context: ResolutionContext): ChannelAdapter {
    const opts = options as Readonly<Record<string, unknown>>;
    const port = typeof opts.port === "number" ? opts.port : DEFAULT_MOBILE_PORT;
    const authToken = typeof opts.authToken === "string" ? opts.authToken : undefined;

    return createMobileChannel({
      port,
      ...(authToken !== undefined ? { authToken, features: { requireAuth: true } } : {}),
    });
  },
};
