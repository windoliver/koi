/**
 * BrickDescriptor for @koi/channel-matrix.
 *
 * Enables manifest auto-resolution for the Matrix channel.
 * homeserverUrl and accessToken are read from environment.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createMatrixChannel } from "./matrix-channel.js";

/**
 * Descriptor for Matrix channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-matrix",
  aliases: ["matrix"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Matrix channel"),
  factory(_options, context: ResolutionContext): ChannelAdapter {
    const homeserverUrl = context.env.MATRIX_HOMESERVER_URL;
    const accessToken = context.env.MATRIX_ACCESS_TOKEN;

    if (homeserverUrl === undefined || homeserverUrl === "") {
      throw new Error(
        "Missing MATRIX_HOMESERVER_URL environment variable. Set it to use the Matrix channel.",
      );
    }
    if (accessToken === undefined || accessToken === "") {
      throw new Error(
        "Missing MATRIX_ACCESS_TOKEN environment variable. Set it to use the Matrix channel.",
      );
    }

    return createMatrixChannel({ homeserverUrl, accessToken });
  },
};
