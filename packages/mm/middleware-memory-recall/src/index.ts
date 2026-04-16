/**
 * @koi/middleware-memory-recall
 *
 * Frozen-snapshot memory recall middleware with optional per-turn
 * relevance selection — injects recalled memories at session start,
 * plus query-relevant memories on each turn.
 */

export { createMemoryRecallMiddleware } from "./memory-recall-middleware.js";
export type { MemoryManifestEntry, RelevanceSelectorConfig } from "./select-relevant.js";
export {
  buildSelectorPrompt,
  parseSelectorResponse,
  selectRelevantMemories,
} from "./select-relevant.js";
export type { MemoryRecallMiddlewareConfig } from "./types.js";
