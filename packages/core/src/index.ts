/**
 * @koi/core — Interfaces-only kernel (Layer 0)
 *
 * Zero runtime code. Zero dependencies.
 * Defines the core contracts: Middleware, Message, Channel, Resolver, Assembly.
 */
export type KoiAgent = {
  readonly name: string;
};

// Search contracts
export type { Embedder, Indexer, Retriever } from "./retriever.js";
// Search value types
export type {
  FusionFunction,
  FusionStrategy,
  IndexDocument,
  ScoreNormalizer,
  SearchErr,
  SearchError,
  SearchFilter,
  SearchOk,
  SearchOutcome,
  SearchPage,
  SearchQuery,
  SearchResult,
  SearchScore,
} from "./search.js";
