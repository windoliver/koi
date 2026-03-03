/**
 * @koi/channel-base — Shared channel abstraction (L0u utility).
 *
 * Provides createChannelAdapter<E>(), a generic factory that builds a complete
 * ChannelAdapter from platform-specific callbacks. Handles all shared channel
 * behavior: connection lifecycle, handler dispatch, capability-aware rendering,
 * sendStatus optionality, and observability hooks.
 *
 * Also exports ContentBlock builder utilities (text, image, file, button, custom)
 * and renderBlocks() for use in MessageNormalizer<E> implementations.
 */

export type { ChannelAdapterConfig, MessageNormalizer } from "./channel-adapter-factory.js";
export { createChannelAdapter } from "./channel-adapter-factory.js";
export type { ContentBlock } from "./content-block-builders.js";
export { button, custom, file, image, text } from "./content-block-builders.js";
export type { Debouncer, DebouncerConfig } from "./debounce.js";
export { createDebouncer } from "./debounce.js";
export type { FormatErrorOptions } from "./format-error.js";
export { formatErrorForChannel } from "./format-error.js";
export type { MediaFallbackConfig } from "./media-fallback.js";
export { createMediaFallback } from "./media-fallback.js";
export type { Reconnector, ReconnectorConfig } from "./reconnect.js";
export { createReconnector } from "./reconnect.js";
export { renderBlocks } from "./render-blocks.js";
export type { RetryQueue, RetryQueueConfig } from "./retry-queue.js";
export { createRetryQueue } from "./retry-queue.js";
export { splitText } from "./split-text.js";
