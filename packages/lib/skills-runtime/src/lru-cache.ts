/**
 * Tiny LRU cache for progressive skill disclosure (issue #1642).
 *
 * Uses JavaScript `Map` insertion-order semantics: a fresh `set` on an existing
 * key must delete-then-reinsert so the key becomes the most-recently-used
 * entry. When size exceeds `max`, the first entry yielded by `keys()` is the
 * least-recently-used and is evicted.
 *
 * Designed as a drop-in replacement for `Map<string, V>` in the skills-runtime
 * loader path — only `get`, `set`, `delete`, `clear`, and `size` are used by
 * callers, so the surface is deliberately small.
 *
 * `max` of 0, a negative value, or `Infinity` disables bounded eviction. This
 * preserves legacy behavior for callers that do not opt in.
 */

export type EvictionReason = "lru" | "invalidate" | "external-refresh";

export interface EvictionEvent {
  readonly key: string;
  readonly reason: EvictionReason;
}

interface BodyCacheConfig {
  readonly max: number;
  readonly onEvict?: (event: EvictionEvent) => void;
}

export interface BodyCache<V> {
  readonly get: (key: string) => V | undefined;
  readonly set: (key: string, value: V) => void;
  /**
   * Deletes `key`. `reason` defaults to `"invalidate"` and is passed through
   * to `onEvict` so callers (e.g., MCP refresh) can distinguish a manual
   * re-sync from a user-triggered invalidation.
   */
  readonly delete: (key: string, reason?: EvictionReason) => boolean;
  readonly has: (key: string) => boolean;
  readonly clear: () => void;
  readonly size: number;
}

export function createBodyCache<V>(config: BodyCacheConfig): BodyCache<V> {
  const bounded = Number.isFinite(config.max) && config.max > 0;
  const max = bounded ? Math.floor(config.max) : Number.POSITIVE_INFINITY;
  const store = new Map<string, V>();
  const onEvict = config.onEvict;

  const touch = (key: string, value: V): void => {
    // Map preserves insertion order; delete-then-set moves the key to the end
    // so iteration ("keys().next()") returns the LRU entry first.
    if (store.has(key)) store.delete(key);
    store.set(key, value);
  };

  const evictOldest = (): void => {
    if (!bounded) return;
    while (store.size > max) {
      const iter = store.keys().next();
      if (iter.done === true) return;
      const oldest = iter.value;
      store.delete(oldest);
      onEvict?.({ key: oldest, reason: "lru" });
    }
  };

  return {
    get(key: string): V | undefined {
      const value = store.get(key);
      if (value === undefined) return undefined;
      // Promote to MRU.
      touch(key, value);
      return value;
    },
    set(key: string, value: V): void {
      touch(key, value);
      evictOldest();
    },
    delete(key: string, reason: EvictionReason = "invalidate"): boolean {
      const existed = store.delete(key);
      if (existed) onEvict?.({ key, reason });
      return existed;
    },
    has(key: string): boolean {
      return store.has(key);
    },
    clear(): void {
      if (store.size === 0) return;
      // Snapshot keys so the caller's callback cannot mutate the map mid-iteration.
      const keys = Array.from(store.keys());
      store.clear();
      if (onEvict === undefined) return;
      for (const key of keys) onEvict({ key, reason: "invalidate" });
    },
    get size(): number {
      return store.size;
    },
  };
}
