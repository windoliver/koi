import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createTeamsShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createTeamsChannel } = await import("@koi/channel-teams");
    return createTeamsChannel(config as unknown as Parameters<typeof createTeamsChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Teams channel, install: bun add @koi/channel-teams", {
      cause: error,
    });
  }
}
