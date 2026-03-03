/**
 * BrickDescriptor for @koi/channel-mobile.
 *
 * Enables manifest auto-resolution for the mobile WebSocket channel.
 * Port is read from options or defaults to 8080.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { DEFAULT_MOBILE_PORT } from "./config.js";
import { createMobileChannel } from "./mobile-channel.js";

/**
 * Descriptor for mobile channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-mobile",
  aliases: ["mobile"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Mobile channel"),
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
