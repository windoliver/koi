/**
 * Content-based verify cache for delegation grants.
 *
 * Caches the boolean outcome of grant verification keyed by
 * `${grantId}:${toolId}`. Invalidated on revocation. Bounded to
 * prevent unbounded growth.
 */

import type { DelegationId } from "@koi/core";

const VERIFY_CACHE_MAX = 1024;

export interface VerifyCache {
  readonly get: (grantId: DelegationId, toolId: string) => boolean | undefined;
  readonly set: (grantId: DelegationId, toolId: string, result: boolean) => void;
  readonly invalidate: (grantId: DelegationId) => void;
  readonly clear: () => void;
}

function cacheKey(grantId: DelegationId, toolId: string): string {
  return `${grantId}:${toolId}`;
}

/** Creates a bounded verify cache keyed by grantId + toolId. */
export function createVerifyCache(): VerifyCache {
  const cache = new Map<string, boolean>();
  // Track which keys belong to each grantId for efficient invalidation
  const grantKeys = new Map<DelegationId, Set<string>>();

  function evictOldest(): void {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;

    cache.delete(oldest);
    // Clean up grantKeys reverse index
    for (const [gid, keys] of grantKeys) {
      if (keys.has(oldest)) {
        keys.delete(oldest);
        if (keys.size === 0) grantKeys.delete(gid);
        break;
      }
    }
  }

  return {
    get: (grantId, toolId) => cache.get(cacheKey(grantId, toolId)),
    set: (grantId, toolId, result) => {
      const key = cacheKey(grantId, toolId);
      // Evict oldest if at capacity and this is a new entry
      if (cache.size >= VERIFY_CACHE_MAX && !cache.has(key)) {
        evictOldest();
      }
      cache.set(key, result);
      // Track in reverse index (Set prevents duplicates)
      const existing = grantKeys.get(grantId);
      if (existing !== undefined) {
        existing.add(key);
      } else {
        grantKeys.set(grantId, new Set([key]));
      }
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
  };
}
