import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createSignalShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createSignalChannel } = await import("@koi/channel-signal");
  return createSignalChannel(config as unknown as Parameters<typeof createSignalChannel>[0]);
}
