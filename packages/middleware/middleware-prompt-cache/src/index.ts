/**
 * @koi/middleware-prompt-cache — Prompt cache optimization middleware.
 *
 * Reorders messages for cache-friendly prefix ordering and emits
 * provider-specific cache hints via side-channel for engine adapters.
 */

export { createPromptCacheMiddleware, PROMPT_CACHE_HINTS } from "./prompt-cache.js";
export { estimateTokens, type ReorderResult, reorderForCache } from "./reorder.js";
export type { CacheHints, PromptCacheConfig, ResolvedPromptCacheConfig } from "./types.js";
export { DEFAULT_PROMPT_CACHE_CONFIG } from "./types.js";
