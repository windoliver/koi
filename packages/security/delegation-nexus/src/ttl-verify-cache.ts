/**
 * TTL-based verification cache with stale-while-revalidate.
 *
 * Caches Nexus verify() results to avoid HTTP round-trips on every tool call.
 * Entries expire after `ttlMs` but are served stale while a background refresh runs.
 */

import type { DelegationId, DelegationVerifyResult } from "@koi/core";

// ---------------------------------------------------------------------------
// Config & types
// ---------------------------------------------------------------------------

export interface TtlVerifyCacheConfig {
  /** TTL for cache entries in milliseconds. Default: 30_000 (30s). */
  readonly ttlMs?: number;
  /** Maximum cache entries. Default: 1024. */
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly result: DelegationVerifyResult;
  readonly cachedAt: number;
  readonly ttlMs: number;
}

export interface TtlVerifyCache {
  /** Get cached result. Returns undefined on miss. Serves stale entries. */
  readonly get: (grantId: DelegationId, toolId: string) => DelegationVerifyResult | undefined;
  /** Check if an entry is stale (past TTL but still in cache). */
  readonly isStale: (grantId: DelegationId, toolId: string) => boolean;
  /** Store a verify result with TTL. */
  readonly set: (grantId: DelegationId, toolId: string, result: DelegationVerifyResult) => void;
  /** Invalidate all entries for a specific grant. */
  readonly invalidate: (grantId: DelegationId) => void;
  /** Clear entire cache. */
  readonly clear: () => void;
  /** Current cache size. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1024;

function cacheKey(grantId: DelegationId, toolId: string): string {
  return `${grantId}:${toolId}`;
}

export function createTtlVerifyCache(config?: TtlVerifyCacheConfig): TtlVerifyCache {
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const cache = new Map<string, CacheEntry>();
  const grantKeys = new Map<DelegationId, Set<string>>();

  function evictOldest(): void {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
    for (const [gid, keys] of grantKeys) {
      if (keys.has(oldest)) {
        keys.delete(oldest);
        if (keys.size === 0) grantKeys.delete(gid);
        break;
      }
    }
  }

  function trackKey(grantId: DelegationId, key: string): void {
    const existing = grantKeys.get(grantId);
    if (existing !== undefined) {
      existing.add(key);
    } else {
      grantKeys.set(grantId, new Set([key]));
    }
  }

  return {
    get: (grantId, toolId) => {
      const entry = cache.get(cacheKey(grantId, toolId));
      if (entry === undefined) return undefined;
      return entry.result;
    },

    isStale: (grantId, toolId) => {
      const entry = cache.get(cacheKey(grantId, toolId));
      if (entry === undefined) return true;
      return Date.now() - entry.cachedAt > entry.ttlMs;
    },

    set: (grantId, toolId, result) => {
      const key = cacheKey(grantId, toolId);
      if (cache.size >= maxEntries && !cache.has(key)) {
        evictOldest();
      }
      cache.set(key, { result, cachedAt: Date.now(), ttlMs });
      trackKey(grantId, key);
    },

    invalidate: (grantId) => {
      const keys = grantKeys.get(grantId);
      if (keys !== undefined) {
        for (const key of keys) {
          cache.delete(key);
        }
        grantKeys.delete(grantId);
      }
    },

    clear: () => {
      cache.clear();
      grantKeys.clear();
    },

    size: () => cache.size,
  };
}
