/**
 * Bounded ring buffer for raw CostEntry audit trail.
 *
 * Stores the most recent N entries in a circular array.
 * Pre-aggregated Maps are the source of truth for aggregates;
 * the ring buffer is append-only for export/debugging.
 */

/** Default capacity — ~2MB at ~200 bytes per entry. */
export const DEFAULT_CAPACITY = 10_000;

export interface RingBuffer<T> {
  /** Append an entry. Oldest entry is evicted when capacity is reached. */
  readonly push: (entry: T) => void;
  /** Return all entries in insertion order (oldest first). */
  readonly toArray: () => readonly T[];
  /** Current number of entries (≤ capacity). */
  readonly size: () => number;
  /** Reset the buffer. */
  readonly clear: () => void;
}

/**
 * Create a bounded ring buffer with fixed capacity.
 *
 * @param capacity Maximum entries to retain. Default: 10,000.
 */
export function createRingBuffer<T>(capacity: number = DEFAULT_CAPACITY): RingBuffer<T> {
  const buf: (T | undefined)[] = new Array(capacity).fill(undefined) as (T | undefined)[];
  // let: mutable write cursor and count
  let head = 0;
  let count = 0;

  return {
    push(entry: T): void {
      buf[head % capacity] = entry;
      head += 1;
      if (count < capacity) count += 1;
    },

    toArray(): readonly T[] {
      if (count === 0) return [];
      const result: T[] = [];
      const start = count < capacity ? 0 : head % capacity;
      for (let i = 0; i < count; i++) {
        const idx = (start + i) % capacity;
        const item = buf[idx];
        if (item !== undefined) result.push(item);
      }
      return result;
    },

    size(): number {
      return count;
    },

    clear(): void {
      buf.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}
