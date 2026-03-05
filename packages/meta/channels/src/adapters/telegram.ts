import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createTelegramShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createTelegramChannel } = await import("@koi/channel-telegram");
  return createTelegramChannel(config as Parameters<typeof createTelegramChannel>[0]);
}
