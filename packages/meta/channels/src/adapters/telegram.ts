import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createTelegramShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createTelegramChannel } = await import("@koi/channel-telegram");
    return createTelegramChannel(config as unknown as Parameters<typeof createTelegramChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Telegram channel, install: bun add @koi/channel-telegram", {
      cause: error,
    });
  }
}
