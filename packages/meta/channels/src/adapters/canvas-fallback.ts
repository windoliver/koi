import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createCanvasFallbackShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createCanvasFallbackChannel } = await import("@koi/channel-canvas-fallback");
  return createCanvasFallbackChannel(config as Parameters<typeof createCanvasFallbackChannel>[0]);
}
