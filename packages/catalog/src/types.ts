/**
 * Internal types for the catalog package.
 *
 * CatalogSourceAdapter is the per-source abstraction that the fan-out
 * utility and resolver compose over. Not exported from the package.
 */

import type { CatalogEntry, CatalogQuery, CatalogSource } from "@koi/core";

// ---------------------------------------------------------------------------
// Source adapter — each source implements this
// ---------------------------------------------------------------------------

export interface CatalogSourceAdapter {
  readonly source: CatalogSource;
  readonly search: (query: CatalogQuery) => Promise<readonly CatalogEntry[]>;
  readonly onChange?: (listener: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// Resolver config
// ---------------------------------------------------------------------------

export interface CatalogResolverConfig {
  readonly adapters: readonly CatalogSourceAdapter[];
  readonly cacheTtlMs?: Partial<Readonly<Record<CatalogSource, number>>>;
}
