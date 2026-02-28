/**
 * CatalogResolver factory — wraps source adapters with TTL caching,
 * fan-out search, and onChange aggregation.
 */

import type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogReader,
  CatalogSource,
  KoiError,
  Result,
} from "@koi/core";
import { notFound } from "@koi/core";

import { createTtlCache } from "./cache.js";
import { fanOut } from "./fan-out.js";
import type { CatalogResolverConfig, CatalogSourceAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Default TTLs per source
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS: Readonly<Record<CatalogSource, number>> = {
  bundled: Infinity,
  forged: 5_000,
  "skill-registry": 5_000,
  mcp: 30_000,
};

// ---------------------------------------------------------------------------
// Cached adapter wrapper
// ---------------------------------------------------------------------------

function wrapWithCache(adapter: CatalogSourceAdapter, ttlMs: number): CatalogSourceAdapter {
  const cache = createTtlCache(() => adapter.search({}), ttlMs);

  // Subscribe to onChange for cache invalidation
  const adapterOnChange = adapter.onChange;
  if (adapterOnChange !== undefined) {
    adapterOnChange(() => cache.invalidate());
  }

  // Wrap search to use cache for unfiltered queries, delegate for filtered
  const cachedSearch = async (query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
    const hasFilters =
      query.kind !== undefined ||
      query.text !== undefined ||
      query.source !== undefined ||
      (query.tags !== undefined && query.tags.length > 0);

    if (!hasFilters) {
      return cache.get();
    }
    return adapter.search(query);
  };

  return {
    source: adapter.source,
    search: cachedSearch,
    ...(adapterOnChange !== undefined ? { onChange: adapterOnChange } : {}),
  };
}

// ---------------------------------------------------------------------------
// Source prefix extraction for optimized get()
// ---------------------------------------------------------------------------

const SOURCE_PREFIXES: ReadonlyMap<string, CatalogSource> = new Map([
  ["bundled", "bundled"],
  ["forged", "forged"],
  ["mcp", "mcp"],
  ["skill-registry", "skill-registry"],
]);

function extractSourceFromName(name: string): CatalogSource | undefined {
  const colonIndex = name.indexOf(":");
  if (colonIndex < 0) return undefined;
  const prefix = name.slice(0, colonIndex);
  return SOURCE_PREFIXES.get(prefix);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CatalogReader that searches across all configured source adapters.
 *
 * Each adapter is wrapped in a per-source TTL cache. Search queries fan out
 * to all (or filtered) adapters in parallel with partial-failure support.
 */
export function createCatalogResolver(config: CatalogResolverConfig): CatalogReader {
  const adapters = config.adapters.map((adapter) => {
    const ttl = config.cacheTtlMs?.[adapter.source] ?? DEFAULT_TTL_MS[adapter.source] ?? 5_000;
    return wrapWithCache(adapter, ttl);
  });

  const search = (query: CatalogQuery): Promise<CatalogPage> => {
    return fanOut(adapters, query);
  };

  const get = async (name: string): Promise<Result<CatalogEntry, KoiError>> => {
    // Optimize: extract source prefix to target only the relevant adapter
    const source = extractSourceFromName(name);
    const query: CatalogQuery = source !== undefined ? { source } : {};
    const page = await fanOut(adapters, query);
    const entry = page.items.find((item: CatalogEntry) => item.name === name);

    if (entry === undefined) {
      return { ok: false, error: notFound(name, `Catalog entry not found: ${name}`) };
    }
    return { ok: true, value: entry };
  };

  // Aggregate onChange from all adapters that support it
  const onChange = (listener: () => void): (() => void) => {
    const unsubscribes = adapters
      .filter(
        (
          a,
        ): a is CatalogSourceAdapter & {
          readonly onChange: (listener: () => void) => () => void;
        } => a.onChange !== undefined,
      )
      .map((a) => a.onChange(listener));

    return () => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  };

  return { search, get, onChange };
}
