/**
 * Simple LRU cache with TTL for caching registry GET responses.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

export interface LruCache<T> {
  readonly get: (key: string) => T | undefined;
  readonly set: (key: string, value: T) => void;
  readonly delete: (key: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

/**
 * Create an LRU cache with TTL-based expiration.
 *
 * Evicts the least-recently-used entry when maxEntries is exceeded.
 * Entries expire after ttlMs milliseconds.
 */
export function createLruCache<T>(
  maxEntries: number,
  ttlMs: number,
  clock: () => number = Date.now,
): LruCache<T> {
  // Using a Map preserves insertion order; re-inserting moves to end
  const entries = new Map<string, CacheEntry<T>>();

  const get = (key: string): T | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;

    // Check expiry
    if (clock() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const set = (key: string, value: T): void => {
    // Remove existing to update position
    entries.delete(key);

    // Evict oldest if at capacity
    if (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) {
        entries.delete(oldestKey);
      }
    }

    entries.set(key, { value, expiresAt: clock() + ttlMs });
  };

  return {
    get,
    set,
    delete: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}
