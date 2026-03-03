/**
 * Fan-out utility — parallel query across multiple catalog source adapters.
 *
 * Pre-filters adapters by query.source, runs Promise.allSettled() on the
 * remainder, merges results, applies limit, and collects partial errors.
 */

import type { CatalogEntry, CatalogPage, CatalogQuery, CatalogSourceError } from "@koi/core";
import { DEFAULT_CATALOG_SEARCH_LIMIT, external } from "@koi/core";

import type { CatalogSourceAdapter } from "./types.js";

/**
 * Fan-out a catalog query across all (or filtered) adapters in parallel.
 *
 * Returns merged results with partial-failure support: healthy source
 * results are included alongside sourceErrors for failed sources.
 */
export async function fanOut(
  adapters: readonly CatalogSourceAdapter[],
  query: CatalogQuery,
): Promise<CatalogPage> {
  // Decision #16A: skip filtered-out sources when query specifies source
  const active =
    query.source !== undefined ? adapters.filter((a) => a.source === query.source) : adapters;

  if (active.length === 0) {
    return { items: [], total: 0 };
  }

  const settled = await Promise.allSettled(active.map((a) => a.search(query)));

  // Separate fulfilled results from rejected ones functionally
  const items: readonly CatalogEntry[] = settled.flatMap((result) =>
    result.status === "fulfilled" ? [...result.value] : [],
  );

  const sourceErrors: readonly CatalogSourceError[] = settled
    .map((result, index) => ({ result, adapter: active[index] }))
    .filter(
      (
        entry,
      ): entry is {
        readonly result: PromiseRejectedResult;
        readonly adapter: CatalogSourceAdapter;
      } => entry.result.status === "rejected" && entry.adapter !== undefined,
    )
    .map(({ result, adapter }) => ({
      source: adapter.source,
      error: external(
        `Catalog source "${adapter.source}" failed: ${String(result.reason)}`,
        result.reason,
      ),
    }));

  const limit = query.limit ?? DEFAULT_CATALOG_SEARCH_LIMIT;
  const limited = items.slice(0, limit);

  const base: CatalogPage = {
    items: limited,
    total: items.length,
  };

  return sourceErrors.length > 0 ? { ...base, sourceErrors } : base;
}
