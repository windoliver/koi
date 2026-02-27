/**
 * Attestation verification cache — avoids re-verifying the same content hash.
 *
 * Keyed by content hash (SHA-256 hex). Invalidated on store change events.
 * Uses an LRU eviction policy to prevent unbounded memory growth in
 * long-running agents with many brick versions.
 */

import { DEFAULT_ATTESTATION_CACHE_CAP } from "./forge-defaults.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly valid: boolean;
  readonly verifiedAt: number;
}

export interface AttestationCache {
  readonly get: (contentHash: string) => CacheEntry | undefined;
  readonly set: (contentHash: string, valid: boolean) => void;
  readonly invalidate: (contentHash: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an LRU-capped attestation verification cache.
 * Defaults to DEFAULT_ATTESTATION_CACHE_CAP entries; oldest entries
 * are evicted when capacity is reached.
 */
export function createAttestationCache(capacity?: number): AttestationCache {
  const cap = capacity ?? DEFAULT_ATTESTATION_CACHE_CAP;
  const cache = new Map<string, CacheEntry>();

  const get = (contentHash: string): CacheEntry | undefined => {
    const entry = cache.get(contentHash);
    if (entry !== undefined) {
      // Move to end (most recently used)
      cache.delete(contentHash);
      cache.set(contentHash, entry);
    }
    return entry;
  };

  const set = (contentHash: string, valid: boolean): void => {
    if (cache.has(contentHash)) {
      cache.delete(contentHash);
    } else if (cache.size >= cap) {
      // Evict least recently used (first entry)
      const first = cache.keys().next().value;
      if (first !== undefined) {
        cache.delete(first);
      }
    }
    cache.set(contentHash, { valid, verifiedAt: Date.now() });
  };

  const invalidate = (contentHash: string): void => {
    cache.delete(contentHash);
  };

  const clear = (): void => {
    cache.clear();
  };

  const size = (): number => {
    return cache.size;
  };

  return { get, set, invalidate, clear, size };
}
