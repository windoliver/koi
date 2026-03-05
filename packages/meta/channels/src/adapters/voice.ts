import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createVoiceShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createVoiceChannel } = await import("@koi/channel-voice");
  return createVoiceChannel(config as Parameters<typeof createVoiceChannel>[0]);
}
