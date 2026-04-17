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
  /** Reset the counter for a new turn. */
  readonly clear: () => void;
}

export function createTurnSoftDenyCounter(): TurnSoftDenyCounter {
  const counts = new Map<string, number>();
  return {
    countAndCap(cacheKey, cap) {
      const current = (counts.get(cacheKey) ?? 0) + 1;
      counts.set(cacheKey, current);
      return current > cap ? "over_cap" : "under_cap";
    },
    clear() {
      counts.clear();
    },
  };
}
