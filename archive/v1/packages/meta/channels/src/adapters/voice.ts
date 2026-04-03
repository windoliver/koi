import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createVoiceShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createVoiceChannel } = await import("@koi/channel-voice");
    return createVoiceChannel(config as unknown as Parameters<typeof createVoiceChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Voice channel, install: bun add @koi/channel-voice", {
      cause: error,
    });
  }
}
