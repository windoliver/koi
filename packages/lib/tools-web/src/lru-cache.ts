/**
 * Generic LRU + TTL cache.
 */

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface LruCache<T> {
  readonly get: (key: string) => T | undefined;
  readonly set: (key: string, value: T) => void;
  /** Drop an entry by key. No-op when the key is absent. */
  readonly delete: (key: string) => void;
}

export function createLruCache<T>(maxEntries: number, ttlMs: number): LruCache<T> {
  const map = new Map<string, CacheEntry<T>>();
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
    set: (key: string, value: T): void => {
      map.delete(key);
      if (map.size >= maxEntries) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete: (key: string): void => {
      map.delete(key);
    },
  };
}
