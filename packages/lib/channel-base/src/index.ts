/**
 * @koi/channel-base — Shared channel abstraction (L0u utility).
 *
 * Provides createChannelAdapter<E>(), a generic factory that builds a complete
 * ChannelAdapter from platform-specific callbacks. Handles all shared channel
 * behavior: connection lifecycle, handler dispatch, capability-aware rendering,
 * and error isolation.
 */

export type { ChannelAdapterConfig, MessageNormalizer } from "./channel-adapter-factory.js";
export { createChannelAdapter } from "./channel-adapter-factory.js";
export { renderBlocks } from "./render-blocks.js";
