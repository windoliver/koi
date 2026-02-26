/**
 * BrickDescriptor for @koi/channel-telegram.
 *
 * Enables manifest auto-resolution for the Telegram bot channel.
 * Token is read from context.env.TELEGRAM_BOT_TOKEN.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import type { TelegramDeployment } from "./telegram-channel.js";
import { createTelegramChannel } from "./telegram-channel.js";

function validateTelegramChannelOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Telegram channel options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

function parseDeployment(options: Readonly<Record<string, unknown>>): TelegramDeployment {
  if (typeof options.webhookUrl === "string") {
    return {
      mode: "webhook",
      webhookUrl: options.webhookUrl,
      ...(typeof options.secretToken === "string" ? { secretToken: options.secretToken } : {}),
    };
  }
  return { mode: "polling" };
}

/**
 * Descriptor for Telegram channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-telegram",
  aliases: ["telegram"],
  optionsValidator: validateTelegramChannelOptions,
  factory(options, context: ResolutionContext): ChannelAdapter {
    const token = context.env.TELEGRAM_BOT_TOKEN;
    if (token === undefined || token === "") {
      throw new Error(
        "Missing TELEGRAM_BOT_TOKEN environment variable. " + "Set it to use the Telegram channel.",
      );
    }

    return createTelegramChannel({
      token,
      deployment: parseDeployment(options),
    });
  },
};
