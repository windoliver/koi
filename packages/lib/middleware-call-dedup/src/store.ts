/**
 * In-memory dedup store — Map-backed with LRU eviction at capacity.
 *
 * LRU is implemented via Map insertion order: get() promotes by re-inserting,
 * set() evicts the oldest entry when at capacity.
 */

import type { CacheEntry, CallDedupStore } from "./types.js";

export function createInMemoryDedupStore(maxEntries: number): CallDedupStore {
  const cache = new Map<string, CacheEntry>();

  return {
    get(key: string): CacheEntry | undefined {
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    },

    set(key: string, entry: CacheEntry): void {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, entry);
    },

    delete(key: string): boolean {
      return cache.delete(key);
    },

    size(): number {
      return cache.size;
    },

    clear(): void {
      cache.clear();
    },
  };
}
