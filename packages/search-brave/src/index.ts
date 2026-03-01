/**
 * @koi/search-brave — Brave Search API adapter (Layer 2)
 *
 * Implements the SearchProvider contract from @koi/search-provider.
 * Exports a BrickDescriptor for manifest auto-resolution.
 * Depends on @koi/core, @koi/search-provider, @koi/resolve — never on L1 or peer L2 packages.
 *
 * Usage:
 * ```ts
 * import { createBraveSearch } from "@koi/search-brave";
 *
 * const provider = createBraveSearch({ apiKey: process.env.BRAVE_API_KEY! });
 * const result = await provider.search("koi agent engine");
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
export { descriptor } from "./descriptor.js";
