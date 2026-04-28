/**
 * @koi/middleware-call-dedup — Cache deterministic tool call results.
 *
 * Identical {sessionId, toolId, input} calls within the TTL return the cached
 * ToolResponse with metadata.cached=true. Mutating tools (shell_exec, file_*,
 * agent_*) are excluded by default. Errored / blocked responses are not cached.
 */

export { createCallDedupMiddleware } from "./call-dedup.js";
export type { CallDedupConfig } from "./config.js";
export {
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  validateCallDedupConfig,
} from "./config.js";
export { createInMemoryDedupStore } from "./store.js";
export type { CacheEntry, CacheHitInfo, CallDedupStore } from "./types.js";
