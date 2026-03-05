import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createEmailShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createEmailChannel } = await import("@koi/channel-email");
  return createEmailChannel(config as Parameters<typeof createEmailChannel>[0]);
}
