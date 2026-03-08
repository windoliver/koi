import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createEmailShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createEmailChannel } = await import("@koi/channel-email");
    return createEmailChannel(config as unknown as Parameters<typeof createEmailChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Email channel, install: bun add @koi/channel-email", {
      cause: error,
    });
  }
}
