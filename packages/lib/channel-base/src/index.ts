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
export type { ChannelFactory, ChannelRegistry } from "./channel-registry.js";
export { createChannelRegistry } from "./channel-registry.js";
export type { ChannelErrorOutput } from "./format-error.js";
export { formatErrorForChannel, formatErrorTextForChannel } from "./format-error.js";
export type { RateLimiter, RateLimiterConfig } from "./rate-limit.js";
export { createRateLimiter } from "./rate-limit.js";
export { renderBlocks } from "./render-blocks.js";
