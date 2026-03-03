/**
 * Search provider contracts — types shared by search backends.
 *
 * ## Web search types
 * `SearchProvider`, `WebSearchResult`, `WebSearchOptions` — contract for
 * web search backends (Brave, Tavily, etc.).
 *
 * ## Index search types
 * `SearchQuery`, `SearchResult`, `SearchPage`, `SearchFilter`, `IndexDocument`,
 * `SearchScore` — contract for index search backends (SQLite, Nexus, etc.).
 *
 * Lives in L0u so both consumers and implementations share compile-time contracts.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Web search — provider interface for web search backends
// ---------------------------------------------------------------------------

/** A single web search result, normalized across all providers. */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Options passed to a search provider's search() method. */
export interface WebSearchOptions {
  readonly maxResults?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

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

// ---------------------------------------------------------------------------
// Index search — value types for indexing and retrieval backends
// ---------------------------------------------------------------------------

/** Score normalized to [0, 1] */
export type SearchScore = number;

/** What the caller wants */
export interface SearchQuery {
  readonly text: string;
  readonly filter?: SearchFilter;
  readonly limit: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly minScore?: SearchScore;
}

/** Single search result */
export interface SearchResult<T = unknown> {
  readonly id: string;
  readonly score: SearchScore;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly data?: T;
}

/** Paginated response */
export interface SearchPage<T = unknown> {
  readonly results: readonly SearchResult<T>[];
  readonly total?: number;
  readonly cursor?: string;
  readonly hasMore: boolean;
}

/** Composable filter tree (discriminated union) */
export type SearchFilter =
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "ne"; readonly field: string; readonly value: unknown }
  | { readonly kind: "gt"; readonly field: string; readonly value: number }
  | { readonly kind: "lt"; readonly field: string; readonly value: number }
  | {
      readonly kind: "in";
      readonly field: string;
      readonly values: readonly unknown[];
    }
  | { readonly kind: "and"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "or"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "not"; readonly filter: SearchFilter };

/** Document for indexing */
export interface IndexDocument<T = unknown> {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly embedding?: readonly number[];
  readonly data?: T;
}
