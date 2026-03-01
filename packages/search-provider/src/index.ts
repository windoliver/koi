/**
 * @koi/search-provider — Pluggable web search provider contract (L0u)
 *
 * Defines the SearchProvider interface that all web search backends implement.
 * Both @koi/tools-web (consumer) and provider packages (@koi/search-brave, etc.)
 * import from this package to share a single compile-time enforced contract.
 *
 * Zero runtime logic — types only.
 */

export type { SearchProvider, WebSearchOptions, WebSearchResult } from "./types.js";
