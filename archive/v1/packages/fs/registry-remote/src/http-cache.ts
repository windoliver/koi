/**
 * ETag + TTL in-memory cache for HTTP responses.
 *
 * Stores response bodies alongside their ETag headers for conditional
 * GET support. LRU eviction keeps memory bounded.
 */

import type { CachedResponse } from "./types.js";
import { DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_CACHE_ENTRIES } from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HttpCache {
  readonly get: (url: string) => CachedResponse | undefined;
  readonly set: (url: string, response: CachedResponse) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HttpCacheConfig {
  readonly ttlMs?: number | undefined;
  readonly maxEntries?: number | undefined;
  readonly clock?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ETag-aware HTTP cache with TTL expiration and LRU eviction.
 *
 * Default: 30s TTL, 100 max entries.
 */
export function createHttpCache(config?: HttpCacheConfig): HttpCache {
  const ttlMs = config?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const clock = config?.clock ?? Date.now;

  // Map preserves insertion order; re-inserting moves to end (most recent)
  const entries = new Map<string, CachedResponse>();

  const get = (url: string): CachedResponse | undefined => {
    const entry = entries.get(url);
    if (entry === undefined) return undefined;

    // Check TTL expiry
    if (clock() - entry.cachedAt >= ttlMs) {
      entries.delete(url);
      return undefined;
    }

    // Move to end (most recently used)
    entries.delete(url);
    entries.set(url, entry);
    return entry;
  };

  const set = (url: string, response: CachedResponse): void => {
    // Remove existing to update position
    entries.delete(url);

    // Evict oldest if at capacity
    if (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) {
        entries.delete(oldestKey);
      }
    }

    entries.set(url, response);
  };

  const clear = (): void => {
    entries.clear();
  };

  const size = (): number => entries.size;

  return { get, set, clear, size };
}
