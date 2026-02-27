/**
 * @koi/tools-web — Web fetch and search tools for agents (Layer 2)
 *
 * Provides a ComponentProvider that wraps a WebExecutor as Tool components.
 * Engines discover these tools via `agent.query<Tool>("tool:")` with zero
 * engine changes.
 *
 * 2 tools: web_fetch, web_search.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 *
 * Usage:
 * ```ts
 * import { createWebProvider, createWebExecutor } from "@koi/tools-web";
 *
 * const executor = createWebExecutor({
 *   searchFn: mySearchBackend, // optional: Brave, Google, SerpAPI, etc.
 *   cacheTtlMs: 300_000,       // 5-min cache for fetch/search results
 * });
 * const provider = createWebProvider({ executor });
 * ```
 */

// constants
export type { WebOperation } from "./constants.js";
export { DEFAULT_PREFIX, OPERATIONS, READ_OPERATIONS, WEB_SYSTEM_PROMPT } from "./constants.js";
// Content conversion utilities
export { htmlToMarkdown } from "./html-to-markdown.js";
export { stripHtml } from "./strip-html.js";
// tool factories — for advanced usage (custom tool composition)
export { createWebFetchTool } from "./tools/web-fetch.js";
export { createWebSearchTool } from "./tools/web-search.js";
// URL policy (SSRF protection)
export { isBlockedUrl } from "./url-policy.js";
// provider
export type { WebProviderConfig } from "./web-component-provider.js";
export { createWebProvider } from "./web-component-provider.js";
// executor
export type {
  WebExecutor,
  WebExecutorConfig,
  WebFetchOptions,
  WebFetchResult,
  WebSearchOptions,
  WebSearchResult,
} from "./web-executor.js";
export {
  createWebExecutor,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./web-executor.js";
