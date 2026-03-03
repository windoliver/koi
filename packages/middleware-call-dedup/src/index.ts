/**
 * @koi/middleware-call-dedup — Deterministic tool call result caching.
 *
 * Caches identical tool call results so the 2nd+ call with the same
 * sessionId + toolId + input returns instantly without re-execution.
 */

export { createCallDedupMiddleware } from "./call-dedup.js";
export type { CallDedupConfig } from "./config.js";
export { DEFAULT_EXCLUDE, validateCallDedupConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createInMemoryDedupStore } from "./store.js";
export type { CacheEntry, CacheHitInfo, CallDedupStore } from "./types.js";
