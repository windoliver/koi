import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createDiscordShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createDiscordChannel } = await import("@koi/channel-discord");
    return createDiscordChannel(config as unknown as Parameters<typeof createDiscordChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Discord channel, install: bun add @koi/channel-discord", {
      cause: error,
    });
  }
}
