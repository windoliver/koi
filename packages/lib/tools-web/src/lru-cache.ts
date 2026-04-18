/**
 * Generic LRU + TTL cache.
 */

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface LruCacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface LruCache<T> {
  readonly get: (key: string) => T | undefined;
  /**
   * Fetch the live entry plus its expiry. Used by callers that need to
   * preserve the remaining lifetime when snapshotting and later restoring
   * an entry (see `noCache` refresh recovery in `web-executor.ts`).
   */
  readonly getEntry: (key: string) => LruCacheEntry<T> | undefined;
  /**
   * Store an entry. `ttlMs` overrides the cache-wide default — use it to
   * cap an entry to an origin-declared freshness budget shorter than
   * the configured TTL, or to restore a snapshot with its remaining
   * lifetime rather than a fresh full TTL.
   */
  readonly set: (key: string, value: T, ttlMs?: number) => void;
  /** Drop an entry by key. No-op when the key is absent. */
  readonly delete: (key: string) => void;
}

export function createLruCache<T>(maxEntries: number, defaultTtlMs: number): LruCache<T> {
  const map = new Map<string, CacheEntry<T>>();
  const evictIfFull = (): void => {
    if (map.size >= maxEntries) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  };
  return {
    get: (key: string): T | undefined => {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    getEntry: (key: string): LruCacheEntry<T> | undefined => {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return entry;
    },
    set: (key: string, value: T, ttlMs?: number): void => {
      map.delete(key);
      evictIfFull();
      const effectiveTtl = ttlMs ?? defaultTtlMs;
      map.set(key, { value, expiresAt: Date.now() + effectiveTtl });
    },
    delete: (key: string): void => {
      map.delete(key);
    },
  };
}
