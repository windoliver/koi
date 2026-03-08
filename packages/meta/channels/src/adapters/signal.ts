import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createSignalShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createSignalChannel } = await import("@koi/channel-signal");
    return createSignalChannel(config as unknown as Parameters<typeof createSignalChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Signal channel, install: bun add @koi/channel-signal", {
      cause: error,
    });
  }
}
