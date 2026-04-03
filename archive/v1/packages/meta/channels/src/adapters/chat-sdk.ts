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
  try {
    const { createChatSdkChannels } = await import("@koi/channel-chat-sdk");
    const adapters = createChatSdkChannels(
      config as unknown as Parameters<typeof createChatSdkChannels>[0],
    );
    if (adapters.length === 0) {
      throw new Error("[channel-chat-sdk] No platforms configured in chat-sdk config");
    }
    if (adapters.length > 1) {
      const names = adapters.map((a) => (a as { readonly name?: string }).name ?? "unknown");
      process.stderr.write(
        `[channel-chat-sdk] Warning: ${String(adapters.length)} platforms configured ` +
          `(${names.join(", ")}), but only the first is used. ` +
          `Configure each platform as a separate channel in the manifest for multi-platform support.\n`,
      );
    }
    return adapters[0] as ChannelAdapter;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("No platforms configured")) {
      throw error;
    }
    throw new Error("To use the Chat SDK channel, install: bun add @koi/channel-chat-sdk", {
      cause: error,
    });
  }
}
