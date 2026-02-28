/**
 * BrickDescriptor for @koi/channel-matrix.
 *
 * Enables manifest auto-resolution for the Matrix channel.
 * homeserverUrl and accessToken are read from environment.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { createMatrixChannel } from "./matrix-channel.js";

function validateMatrixChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Matrix channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for Matrix channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-matrix",
  aliases: ["matrix"],
  optionsValidator: validateMatrixChannelOptions,
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
