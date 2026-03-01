/**
 * Generation-based read cache with LRU eviction.
 *
 * On read: check cache → generation RPC → compare → serve cached or fetch fresh.
 * Zero-cost reads when data hasn't changed.
 */

import type { AgentGroupId, KoiError, Result, ScratchpadEntry, ScratchpadPath } from "@koi/core";
import { MAX_CACHE_SIZE } from "./constants.js";
import type { ScratchpadClient } from "./scratchpad-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly entry: ScratchpadEntry;
  /** Timestamp for LRU ordering. */
  lastAccessed: number;
}

export interface GenerationCache {
  /** Read with generation-based caching. */
  readonly read: (
    groupId: AgentGroupId,
    path: ScratchpadPath,
  ) => Promise<Result<ScratchpadEntry, KoiError>>;
  /** Invalidate a specific path. */
  readonly invalidate: (path: ScratchpadPath) => void;
  /** Clear the entire cache. */
  readonly clear: () => void;
  /** Number of cached entries. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a generation-based read cache backed by a ScratchpadClient. */
export function createGenerationCache(
  client: ScratchpadClient,
  maxSize: number = MAX_CACHE_SIZE,
): GenerationCache {
  // let justified: mutable LRU cache map
  const cache = new Map<string, CacheEntry>();

  function cacheKey(groupId: AgentGroupId, path: ScratchpadPath): string {
    return `${groupId}:${path}`;
  }

  function evictIfFull(): void {
    if (cache.size < maxSize) return;

    // Find LRU entry
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  return {
    read: async (groupId, path) => {
      const key = cacheKey(groupId, path);
      const cached = cache.get(key);

      if (cached !== undefined) {
        // Check if the cached generation is still current
        const genResult = await client.generation(groupId, path);
        if (!genResult.ok) {
          // On generation check failure, fall through to full read
          cache.delete(key);
        } else if (genResult.value === cached.entry.generation) {
          // Cache hit — update access time and return cached entry
          cached.lastAccessed = Date.now();
          return { ok: true, value: cached.entry };
        } else {
          // Stale — remove and fetch fresh
          cache.delete(key);
        }
      }

      // Cache miss or stale — fetch full entry
      const result = await client.read(groupId, path);
      if (!result.ok) return result;

      // Store in cache
      evictIfFull();
      cache.set(key, {
        entry: result.value,
        lastAccessed: Date.now(),
      });

      return result;
    },

    invalidate: (path) => {
      // Invalidate all groups for this path
      for (const key of cache.keys()) {
        if (key.endsWith(`:${path}`)) {
          cache.delete(key);
        }
      }
    },

    clear: () => {
      cache.clear();
    },

    size: () => cache.size,
  };
}
