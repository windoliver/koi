import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

/**
 * Chat SDK shim — creates a single composite adapter from the chat-sdk package.
 *
 * Note: createChatSdkChannels() returns an array of adapters (one per platform).
 * This shim returns the first adapter. For multi-platform chat-sdk usage,
 * configure each platform as a separate channel in the manifest.
 */
export async function createChatSdkShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createChatSdkChannels } = await import("@koi/channel-chat-sdk");
  const adapters = createChatSdkChannels(config as Parameters<typeof createChatSdkChannels>[0]);
  if (adapters.length === 0) {
    throw new Error("[channel-chat-sdk] No platforms configured in chat-sdk config");
  }
  return adapters[0] as ChannelAdapter;
}
