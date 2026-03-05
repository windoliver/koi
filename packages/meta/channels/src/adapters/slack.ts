import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createSlackShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createSlackChannel } = await import("@koi/channel-slack");
  return createSlackChannel(config as Parameters<typeof createSlackChannel>[0]);
}
