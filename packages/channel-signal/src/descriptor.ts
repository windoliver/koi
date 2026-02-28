/**
 * BrickDescriptor for @koi/channel-signal.
 *
 * Enables manifest auto-resolution for the Signal channel.
 * Account phone number is read from SIGNAL_ACCOUNT env var.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { createSignalChannel } from "./signal-channel.js";

function validateSignalChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Signal channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for Signal channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-signal",
  aliases: ["signal"],
  optionsValidator: validateSignalChannelOptions,
  factory(options, context: ResolutionContext): ChannelAdapter {
    const account = context.env.SIGNAL_ACCOUNT;
    if (account === undefined || account === "") {
      throw new Error(
        "Missing SIGNAL_ACCOUNT environment variable. Set it to the registered phone number.",
      );
    }

    const opts = options as Readonly<Record<string, unknown>>;
    return createSignalChannel({
      account,
      ...(typeof opts.signalCliPath === "string" ? { signalCliPath: opts.signalCliPath } : {}),
      ...(typeof opts.configPath === "string" ? { configPath: opts.configPath } : {}),
    });
  },
};
