/**
 * Vector clock operations — pure functions, no I/O.
 *
 * Used for causal ordering of federation sync events across zones.
 */

import type { ClockOrder, FederationSyncEvent, SyncCursor, VectorClock } from "./types.js";

/**
 * Increment the clock component for the given zone.
 * Returns a new VectorClock (immutable).
 */
export function incrementClock(clock: VectorClock, zoneId: string): VectorClock {
  const current = clock[zoneId] ?? 0;
  return { ...clock, [zoneId]: current + 1 };
}

/**
 * Merge two vector clocks by taking the component-wise maximum.
 * Returns a new VectorClock (immutable).
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const result: Record<string, number> = { ...a };
  for (const key of Object.keys(b)) {
    const bVal = b[key];
    if (bVal !== undefined) {
      const aVal = result[key] ?? 0;
      result[key] = Math.max(aVal, bVal);
    }
  }
  return result;
}

/**
 * Compare two vector clocks.
 *
 * Returns:
 * - "equal" if all components are identical
 * - "before" if a ≤ b (and a ≠ b) — a happened-before b
 * - "after" if a ≥ b (and a ≠ b) — a happened-after b
 * - "concurrent" if neither dominates — causally independent
 */
export function compareClock(a: VectorClock, b: VectorClock): ClockOrder {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  // let: flags toggled during component-wise comparison loop
  let aBeforeB = false;
  let bBeforeA = false;

  for (const key of allKeys) {
    const aVal = a[key] ?? 0;
    const bVal = b[key] ?? 0;

    if (aVal < bVal) {
      aBeforeB = true;
    } else if (aVal > bVal) {
      bBeforeA = true;
    }

    // Short-circuit: if both flags are set, clocks are concurrent
    if (aBeforeB && bBeforeA) return "concurrent";
  }

  if (!aBeforeB && !bBeforeA) return "equal";
  if (aBeforeB) return "before";
  return "after";
}

/**
 * Check whether a sync event should be applied given the current cursor.
 * An event is applicable if its sequence > cursor.lastSequence for that zone.
 */
export function isAfterCursor(
  event: FederationSyncEvent,
  cursor: SyncCursor,
  zoneId: string,
): boolean {
  if (event.originZoneId !== zoneId) return false;
  return event.sequence > cursor.lastSequence;
}

/**
 * Prune idle zones from a vector clock.
 * Removes entries for zones whose last activity is older than cutoffAt.
 *
 * @param clock - The vector clock to prune
 * @param lastActiveTimes - Map of zoneId → last activity timestamp (ms)
 * @param cutoffAt - Timestamp threshold; zones inactive before this are pruned
 */
export function pruneClock(
  clock: VectorClock,
  lastActiveTimes: Readonly<Record<string, number>>,
  cutoffAt: number,
): VectorClock {
  const result: Record<string, number> = {};
  for (const key of Object.keys(clock)) {
    const lastActive = lastActiveTimes[key];
    // Keep if no activity data (conservative) or if recently active
    if (lastActive === undefined || lastActive >= cutoffAt) {
      const val = clock[key];
      if (val !== undefined) {
        result[key] = val;
      }
    }
  }
  return result;
}
