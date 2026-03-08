import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createSlackShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createSlackChannel } = await import("@koi/channel-slack");
    return createSlackChannel(config as unknown as Parameters<typeof createSlackChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Slack channel, install: bun add @koi/channel-slack", {
      cause: error,
    });
  }
}
