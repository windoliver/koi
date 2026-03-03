/**
 * In-memory dedup store — Map-backed, LRU eviction, sync returns.
 */

import type { CacheEntry, CallDedupStore } from "./types.js";

/**
 * Creates a Map-backed dedup store with LRU eviction.
 *
 * LRU is implemented via Map insertion order:
 * - `get()` deletes and re-inserts the entry to promote it
 * - `set()` evicts the oldest entry when at capacity
 *
 * All operations are synchronous (no async overhead for the common case).
 */
export function createInMemoryDedupStore(maxEntries: number): CallDedupStore {
  const cache = new Map<string, CacheEntry>();

  return {
    get(key: string): CacheEntry | undefined {
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      // LRU promotion: delete and re-insert to move to end
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    },

    set(key: string, entry: CacheEntry): void {
      // If key already exists, delete first to refresh insertion order
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxEntries) {
        // Evict oldest (first) entry
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
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
