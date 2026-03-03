/**
 * BrickDescriptor for @koi/channel-cli.
 *
 * Enables manifest auto-resolution for the CLI stdin/stdout channel.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createCliChannel } from "./cli-channel.js";

/**
 * Descriptor for CLI channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-cli",
  aliases: ["cli"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "CLI channel"),
  factory(): ChannelAdapter {
    return createCliChannel();
  },
};
