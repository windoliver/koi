/**
 * Attestation verification cache — avoids re-verifying the same content hash.
 *
 * Keyed by content hash (SHA-256 hex). Invalidated on store change events.
 */

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
 * Create an in-memory attestation verification cache.
 */
export function createAttestationCache(): AttestationCache {
  const cache = new Map<string, CacheEntry>();

  const get = (contentHash: string): CacheEntry | undefined => {
    return cache.get(contentHash);
  };

  const set = (contentHash: string, valid: boolean): void => {
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
