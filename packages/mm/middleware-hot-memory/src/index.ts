/**
 * @koi/middleware-hot-memory — Hot-tier memory injection (Layer 2)
 *
 * Injects hot-tier memories into model calls at configurable intervals.
 * Depends on @koi/core only.
 */

export { createHotMemoryMiddleware } from "./hot-memory-middleware.js";
export type { HotMemoryConfig, HotMemoryDefaults } from "./types.js";
export { HOT_MEMORY_DEFAULTS } from "./types.js";
