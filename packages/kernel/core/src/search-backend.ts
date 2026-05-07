/**
 * Search backend — pluggable index-search and retrieval contracts.
 *
 * Models the read (Retriever) and write (Indexer) paths for a full-text /
 * keyword index. Pure types only — no runtime code.
 *
 * Distinct from skill-registry's `SkillSearchQuery` (catalog filter) and
 * filesystem-backend's `FileSearchOptions` (grep-style file search).
 *
 * Pluggable backends include nexus-backed REST search, SQLite FTS5, and
 * in-memory implementations.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/** Relevance score normalized to [0, 1]. */
export type SearchScore = number;

// ---------------------------------------------------------------------------
// Filter — composable predicate tree
// ---------------------------------------------------------------------------

/**
 * Composable filter tree applied to indexed metadata.
 *
 * Backends that cannot express the full grammar should reject queries with
 * a `KoiError` rather than silently dropping clauses.
 */
export type SearchFilter =
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "ne"; readonly field: string; readonly value: unknown }
  | { readonly kind: "gt"; readonly field: string; readonly value: number }
  | { readonly kind: "lt"; readonly field: string; readonly value: number }
  | { readonly kind: "in"; readonly field: string; readonly values: readonly unknown[] }
  | { readonly kind: "and"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "or"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "not"; readonly filter: SearchFilter };

// ---------------------------------------------------------------------------
// Query / result / page
// ---------------------------------------------------------------------------

export interface SearchQuery {
  readonly text: string;
  readonly filter?: SearchFilter;
  readonly limit: number;
  /** Opaque cursor for the next page. undefined = first page. */
  readonly cursor?: string;
  /** Drop results below this score. */
  readonly minScore?: SearchScore;
}

export interface SearchResult<T = unknown> {
  readonly id: string;
  readonly score: SearchScore;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Backend-supplied origin (e.g., index name, table). */
  readonly source: string;
  readonly data?: T;
}

export interface SearchPage<T = unknown> {
  readonly results: readonly SearchResult<T>[];
  /** Total matching documents. Optional — some backends can't count cheaply. */
  readonly total?: number;
  /** Opaque cursor for the next page. undefined = no more pages. */
  readonly cursor?: string;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Index document — input to write path
// ---------------------------------------------------------------------------

export interface IndexDocument<T = unknown> {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly data?: T;
}

// ---------------------------------------------------------------------------
// Retriever (read path) — required for all backends
// ---------------------------------------------------------------------------

export interface Retriever<T = unknown> {
  readonly retrieve: (query: SearchQuery) => Promise<Result<SearchPage<T>, KoiError>>;
}

// ---------------------------------------------------------------------------
// Indexer (write path) — only writable backends
// ---------------------------------------------------------------------------

export interface Indexer<T = unknown> {
  readonly index: (documents: readonly IndexDocument<T>[]) => Promise<Result<void, KoiError>>;
  readonly remove: (ids: readonly string[]) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Combined backend
// ---------------------------------------------------------------------------

/** Full search backend that supports both reading and writing. */
export interface SearchBackend<T = unknown> extends Retriever<T>, Indexer<T> {}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default page size when callers omit `limit`. */
export const DEFAULT_SEARCH_LIMIT: 25 = 25;
