import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createCliShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createCliChannel } = await import("@koi/channel-cli");
    return createCliChannel(config);
  } catch (error: unknown) {
    throw new Error("To use the CLI channel, install: bun add @koi/channel-cli", {
      cause: error,
    });
  }
}
