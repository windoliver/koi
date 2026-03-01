/**
 * Search provider contract — the formal interface for web search backends.
 *
 * Lives in L0u so both @koi/tools-web (consumer) and search provider
 * implementations (@koi/search-brave, etc.) share a single contract
 * with compile-time enforcement.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Search result — the canonical normalized shape
// ---------------------------------------------------------------------------

/** A single web search result, normalized across all providers. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

// ---------------------------------------------------------------------------
// Search options — provider-agnostic
// ---------------------------------------------------------------------------

/** Options passed to a search provider's search() method. */
export interface WebSearchOptions {
  readonly maxResults?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// SearchProvider — the formal contract
// ---------------------------------------------------------------------------

/**
 * A pluggable web search backend.
 *
 * Implementations return normalized `WebSearchResult[]` wrapped in `Result`.
 * Agent manifests declare `search: { name: "brave" }` and the resolve layer
 * instantiates the matching provider via its `BrickDescriptor`.
 */
export interface SearchProvider {
  /** Provider name (e.g., "brave", "tavily", "searxng"). */
  readonly name: string;
  /** Execute a web search query. */
  readonly search: (
    query: string,
    options?: WebSearchOptions,
  ) => Promise<Result<readonly WebSearchResult[], KoiError>>;
}
