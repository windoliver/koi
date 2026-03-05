import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

export async function createMatrixShim(
  config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  const { createMatrixChannel } = await import("@koi/channel-matrix");
  return createMatrixChannel(config as Parameters<typeof createMatrixChannel>[0]);
}
