import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createDiscordShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createDiscordChannel } = await import("@koi/channel-discord");
  return createDiscordChannel(config as Parameters<typeof createDiscordChannel>[0]);
}
