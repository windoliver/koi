/**
 * Generic TTL cache wrapper for source adapter results.
 *
 * Wraps an async fetch function with time-based caching and manual
 * invalidation. Used by the catalog resolver to cache per-source results.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TtlCache<T> {
  readonly get: () => Promise<T>;
  readonly invalidate: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TTL cache around an async fetch function.
 *
 * @param fetchFn - Async function that produces the cached value.
 * @param ttlMs - Time-to-live in milliseconds. Use Infinity for static data.
 */
export function createTtlCache<T>(fetchFn: () => Promise<T>, ttlMs: number): TtlCache<T> {
  // let justified: mutable cache state
  let cached: T | undefined;
  let fetchedAt = 0;
  let inflight: Promise<T> | undefined;

  function isExpired(): boolean {
    if (cached === undefined) return true;
    if (ttlMs === Infinity) return false;
    return Date.now() - fetchedAt >= ttlMs;
  }

  const get = async (): Promise<T> => {
    if (!isExpired() && cached !== undefined) {
      return cached;
    }

    // Deduplicate concurrent requests
    if (inflight !== undefined) {
      return inflight;
    }

    inflight = fetchFn().then((value) => {
      cached = value;
      fetchedAt = Date.now();
      inflight = undefined;
      return value;
    });

    // On error, clear inflight so next call retries
    inflight.catch(() => {
      inflight = undefined;
    });

    return inflight;
  };

  const invalidate = (): void => {
    cached = undefined;
    fetchedAt = 0;
  };

  return { get, invalidate };
}
