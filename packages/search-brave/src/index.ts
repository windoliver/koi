/**
 * @koi/search-brave — Brave Search API adapter (Layer 2)
 *
 * Produces a search function compatible with @koi/tools-web's WebExecutorConfig.searchFn.
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 *
 * Usage:
 * ```ts
 * import { createBraveSearch } from "@koi/search-brave";
 * import { createWebExecutor } from "@koi/tools-web";
 *
 * const searchFn = createBraveSearch({ apiKey: process.env.BRAVE_API_KEY! });
 * const executor = createWebExecutor({ searchFn, cacheTtlMs: 300_000 });
 * ```
 */

export type {
  BraveSearchConfig,
  BraveSearchFn,
  BraveSearchOptions,
  BraveSearchResult,
} from "./brave-search.js";
export {
  createBraveSearch,
  DEFAULT_BRAVE_BASE_URL,
  DEFAULT_BRAVE_TIMEOUT_MS,
} from "./brave-search.js";
