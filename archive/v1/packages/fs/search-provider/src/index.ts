/**
 * @koi/search-provider — Pluggable search provider contracts (L0u)
 *
 * Pure types and interfaces for both web search and index search backends.
 * No runtime code, no dependencies beyond @koi/core.
 */

export type { Embedder, Indexer, Retriever } from "./contracts.js";
export type {
  IndexDocument,
  SearchFilter,
  SearchPage,
  SearchProvider,
  SearchQuery,
  SearchResult,
  SearchScore,
  WebSearchOptions,
  WebSearchResult,
} from "./types.js";
