/**
 * BrickDescriptor for @koi/channel-whatsapp.
 *
 * Enables manifest auto-resolution for the WhatsApp channel.
 * Auth state path is read from options or defaults to "./whatsapp_auth".
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createWhatsAppChannel } from "./whatsapp-channel.js";

function validateWhatsAppChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "WhatsApp channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for WhatsApp channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-whatsapp",
  aliases: ["whatsapp"],
  optionsValidator: validateWhatsAppChannelOptions,
  factory(options): ChannelAdapter {
    const opts = options as Readonly<Record<string, unknown>>;
    const authStatePath =
      typeof opts.authStatePath === "string" ? opts.authStatePath : "./whatsapp_auth";

    return createWhatsAppChannel({ authStatePath });
  },
};
