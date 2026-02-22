/**
 * @koi/core — Search contracts (Layer 0)
 *
 * Interfaces only — no runtime code.
 */

import type { IndexDocument, SearchOutcome, SearchPage, SearchQuery } from "./search.js";

/** Contract 1: Retriever (read path) */
export interface Retriever<T = unknown> {
  readonly retrieve: (query: SearchQuery) => Promise<SearchOutcome<SearchPage<T>>>;
}

/** Contract 2: Embedder (embedding generation) */
export interface Embedder {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly embedMany: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
  readonly dimensions: number;
}

/** Contract 3: Indexer (write path) */
export interface Indexer<T = unknown> {
  readonly index: (documents: readonly IndexDocument<T>[]) => Promise<SearchOutcome<void>>;
  readonly remove: (ids: readonly string[]) => Promise<SearchOutcome<void>>;
}
