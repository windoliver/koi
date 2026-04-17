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
   */
  readonly peekMaxByPrefix: (prefix: string) => number;
  /**
   * Reclaim entries for turns older than `beforeTurnIndex`. Callers parse a
   * numeric turnIndex prefix `${turnIndex}\0...` from each key. Entries
   * without a parseable numeric prefix are left alone. Used by the middleware's
   * `onBeforeTurn` to reap state from completed/old turns without wiping
   * overlapping in-flight turns. Loop round-8 fix.
   */
  readonly expireOlderThan: (beforeTurnIndex: number) => void;
  /** Reset all counters (called on full teardown — rarely needed per-turn). */
  readonly clear: () => void;
}

/**
 * Defensive ceiling: if a single counter instance ever holds more than this
 * many distinct keys (across all turns in a long-lived session), subsequent
 * `countAndCap` calls return `"over_cap"` regardless of per-key count.
 * This is fail-closed behavior: rather than LRU-evict (which would bypass the
 * cap by dropping older entries), we refuse new retries once the structure is
 * saturated. Session-end wipes the counter so the ceiling is naturally
 * bounded by session lifetime.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

export function createTurnSoftDenyCounter(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): TurnSoftDenyCounter {
  const counts = new Map<string, number>();

  return {
    countAndCap(cacheKey, cap) {
      // Fail-closed when at the global ceiling and the key is new. An attacker
      // rotating through >maxEntries distinct keys to reset the cap will hit
      // "over_cap" regardless of per-key count. Loop round-7 fix.
      if (counts.size >= maxEntries && !counts.has(cacheKey)) {
        return "over_cap";
      }
      const current = (counts.get(cacheKey) ?? 0) + 1;
      counts.set(cacheKey, current);
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
    expireOlderThan(beforeTurnIndex) {
      // Keys are `${turnIndex}\0${cacheKey}`; parse the turnIndex prefix.
      for (const key of counts.keys()) {
        const nullIdx = key.indexOf("\0");
        if (nullIdx <= 0) continue;
        const prefix = key.slice(0, nullIdx);
        const turnIdx = Number(prefix);
        if (Number.isFinite(turnIdx) && turnIdx < beforeTurnIndex) {
          counts.delete(key);
        }
      }
    },
    clear() {
      counts.clear();
    },
  };
}
