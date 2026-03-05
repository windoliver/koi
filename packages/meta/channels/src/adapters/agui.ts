import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

/**
 * AG-UI shim — creates an AG-UI SSE channel adapter.
 *
 * Note: createAguiChannel() returns { channel, middleware }. This shim
 * returns only the channel adapter. The middleware should be configured
 * separately in the manifest's middleware[] array.
 */
export async function createAguiShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createAguiChannel } = await import("@koi/channel-agui");
  const result = createAguiChannel(config as Parameters<typeof createAguiChannel>[0]);
  return result.channel;
}
