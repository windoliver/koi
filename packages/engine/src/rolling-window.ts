/**
 * Rolling time window — circular buffer of timestamps for rate computation.
 *
 * Used by the governance controller to track error rates over a configurable
 * time window. Pre-allocated circular array for O(1) amortized insert.
 * count() scans from newest, stops at first entry outside window — O(k)
 * where k = events in the current window.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RollingWindow {
  /** Record an event at the given timestamp. */
  readonly record: (timestamp: number) => void;
  /** Count events within the current time window. */
  readonly count: (now: number) => number;
  /** Compute rate: events in window / total. Clamped to 0-1. */
  readonly rate: (total: number, now: number) => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 1000;

export function createRollingWindow(
  windowMs: number,
  maxEntries?: number | undefined,
): RollingWindow {
  const capacity = maxEntries ?? DEFAULT_MAX_ENTRIES;
  const buffer: number[] = new Array<number>(capacity).fill(0);
  // let justified: mutable cursor and fill count for circular buffer
  let cursor = 0;
  let filled = 0;

  function record(timestamp: number): void {
    buffer[cursor] = timestamp;
    cursor = (cursor + 1) % capacity;
    if (filled < capacity) {
      filled++;
    }
  }

  function count(now: number): number {
    const cutoff = now - windowMs;
    // let justified: mutable counter scanning from newest backwards
    let result = 0;
    for (let i = 0; i < filled; i++) {
      // Walk backwards from newest entry
      const idx = (cursor - 1 - i + capacity) % capacity;
      const ts = buffer[idx];
      if (ts === undefined || ts < cutoff) {
        break;
      }
      result++;
    }
    return result;
  }

  function rate(total: number, now: number): number {
    if (total <= 0) return 0;
    const c = count(now);
    return Math.min(1, c / total);
  }

  return { record, count, rate };
}
