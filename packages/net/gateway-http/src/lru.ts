export interface Lru<K, V> {
  readonly get: (key: K) => V | undefined;
  readonly set: (key: K, value: V) => void;
  readonly has: (key: K) => boolean;
  readonly delete: (key: K) => boolean;
  readonly size: () => number;
}

export function createLru<K, V>(capacity: number): Lru<K, V> {
  if (capacity <= 0) throw new Error("LRU capacity must be > 0");
  const map = new Map<K, V>();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key) as V;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    has: (key) => map.has(key),
    delete: (key) => map.delete(key),
    size: () => map.size,
  };
}
