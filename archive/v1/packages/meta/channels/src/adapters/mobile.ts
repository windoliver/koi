import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createMobileShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createMobileChannel } = await import("@koi/channel-mobile");
    return createMobileChannel(config as unknown as Parameters<typeof createMobileChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Mobile channel, install: bun add @koi/channel-mobile", {
      cause: error,
    });
  }
}
