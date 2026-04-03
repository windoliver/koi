/**
 * BrickDescriptor for @koi/channel-whatsapp.
 *
 * Enables manifest auto-resolution for the WhatsApp channel.
 * Auth state path is read from options or defaults to "./whatsapp_auth".
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createWhatsAppChannel } from "./whatsapp-channel.js";

/**
 * Descriptor for WhatsApp channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-whatsapp",
  aliases: ["whatsapp"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "WhatsApp channel"),
  factory(options): ChannelAdapter {
    const opts = options as Readonly<Record<string, unknown>>;
    const authStatePath =
      typeof opts.authStatePath === "string" ? opts.authStatePath : "./whatsapp_auth";

    return createWhatsAppChannel({ authStatePath });
  },
};
