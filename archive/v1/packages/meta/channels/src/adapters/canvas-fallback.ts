import type { ChannelAdapter, JsonObject } from "@koi/core";
import type { ChannelRuntimeOpts } from "../types.js";

/**
 * Canvas-fallback is a wrapper adapter (takes an inner ChannelAdapter + config),
 * not a standalone channel factory. It cannot be created from manifest config alone.
 * Use it directly via `@koi/channel-canvas-fallback` when wrapping another channel.
 */
export function createCanvasFallbackShim(
  _config: JsonObject,
  _opts?: ChannelRuntimeOpts,
): Promise<ChannelAdapter> {
  throw new Error(
    "canvas-fallback is a wrapper adapter — it wraps another channel, not a standalone channel. " +
      "Import createCanvasFallbackChannel from @koi/channel-canvas-fallback directly.",
  );
}
