import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createMatrixShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  try {
    const { createMatrixChannel } = await import("@koi/channel-matrix");
    return createMatrixChannel(config as unknown as Parameters<typeof createMatrixChannel>[0]);
  } catch (error: unknown) {
    throw new Error("To use the Matrix channel, install: bun add @koi/channel-matrix", {
      cause: error,
    });
  }
}
