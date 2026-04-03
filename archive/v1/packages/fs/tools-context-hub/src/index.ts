/**
 * @koi/tools-context-hub — Search and fetch curated API docs from Context Hub (Layer 2)
 *
 * Provides a ComponentProvider that wraps a ContextHubExecutor as Tool components.
 * Engines discover these tools via `agent.query<Tool>("tool:")` with zero
 * engine changes.
 *
 * 2 tools: chub_search, chub_get.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 *
 * Usage:
 * ```ts
 * import { createContextHubProvider, createContextHubExecutor } from "@koi/tools-context-hub";
 *
 * const executor = createContextHubExecutor({
 *   cacheTtlMs: 21_600_000, // 6-hour cache (default)
 * });
 * const provider = createContextHubProvider({ executor });
 * ```
 */

// BM25 search (for advanced usage / testing)
export type { SearchIndex, SearchIndexEntry, SearchResult } from "./bm25.js";
export { buildSearchIndex, searchIndex, tokenize } from "./bm25.js";

// executor
export type {
  ChubGetResult,
  ChubSearchResult,
  ContextHubExecutor,
  ContextHubExecutorConfig,
  Registry,
  RegistryDoc,
  RegistryDocLanguage,
  RegistryDocVersion,
} from "./context-hub-executor.js";
export {
  createContextHubExecutor,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_TIMEOUT_MS,
} from "./context-hub-executor.js";
// provider
export type { ContextHubOperation, ContextHubProviderConfig } from "./provider.js";
export { createContextHubProvider, OPERATIONS } from "./provider.js";
// skill
export { CONTEXT_HUB_SKILL, CONTEXT_HUB_SKILL_CONTENT, CONTEXT_HUB_SKILL_NAME } from "./skill.js";
// tool factories — for advanced usage (custom tool composition)
export { createChubGetTool } from "./tools/chub-get.js";
export { createChubSearchTool } from "./tools/chub-search.js";
