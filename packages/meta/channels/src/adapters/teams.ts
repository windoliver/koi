import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createTeamsShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createTeamsChannel } = await import("@koi/channel-teams");
  return createTeamsChannel(config as unknown as Parameters<typeof createTeamsChannel>[0]);
}
