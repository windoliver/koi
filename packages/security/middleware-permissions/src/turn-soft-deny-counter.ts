/**
 * Per-turn soft-deny retry counter (#1650).
 *
 * Cumulative count of soft denies per `decisionCacheKey` within the current
 * turn. After `cap` cumulative denies for the same key, the (cap+1)th deny
 * hard-throws. Allow decisions do NOT reset the counter — this prevents a
 * model from alternating denied/allowed calls on the same coarse cacheKey
 * to indefinitely avoid the cap. Counter is cleared only at turn boundary
 * via the `onBeforeTurn` middleware hook.
 *
 * NOT exported from `index.ts` — internal to the package.
 */

export interface TurnSoftDenyCounter {
  /**
   * Increment the counter for `cacheKey` and report whether it exceeds `cap`.
   * Returns `"over_cap"` when the new count is > cap, `"under_cap"` otherwise.
   */
  readonly countAndCap: (cacheKey: string, cap: number) => "under_cap" | "over_cap";
  /**
   * Read current count for `cacheKey` WITHOUT incrementing.
   */
  readonly peek: (cacheKey: string) => number;
  /**
   * Peek the HIGHEST count across all entries whose key starts with `prefix`.
   * Used by planning-time filters to check if any path/variant under a given
   * tool prefix has already exhausted cap — even when the exact future
   * cacheKey is not yet known (e.g., fs tools where resolvedPath is not
   * available at planning time).
   */
  readonly peekMaxByPrefix: (prefix: string) => number;
  /** Reset all counters (called on full teardown — rarely needed per-turn). */
  readonly clear: () => void;
}

const DEFAULT_MAX_ENTRIES = 1024;

export function createTurnSoftDenyCounter(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): TurnSoftDenyCounter {
  // Insertion-ordered Map → JavaScript Map iteration is insertion-ordered,
  // so deleting-and-reinserting on write yields LRU-on-insertion behavior.
  const counts = new Map<string, number>();

  function evictIfNeeded(): void {
    if (counts.size <= maxEntries) return;
    // Drop the oldest entry (insertion order).
    const oldest = counts.keys().next().value;
    if (oldest !== undefined) counts.delete(oldest);
  }

  return {
    countAndCap(cacheKey, cap) {
      const current = (counts.get(cacheKey) ?? 0) + 1;
      // Reinsert so recently-used keys stay near the head.
      counts.delete(cacheKey);
      counts.set(cacheKey, current);
      evictIfNeeded();
      return current > cap ? "over_cap" : "under_cap";
    },
    peek(cacheKey) {
      return counts.get(cacheKey) ?? 0;
    },
    peekMaxByPrefix(prefix) {
      let max = 0;
      for (const [k, v] of counts) {
        if (k.startsWith(prefix) && v > max) max = v;
      }
      return max;
    },
    clear() {
      counts.clear();
    },
  };
}
