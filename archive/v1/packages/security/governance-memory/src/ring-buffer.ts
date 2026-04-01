/**
 * Fixed-capacity ring buffer — append-only with oldest eviction.
 *
 * Used for compliance records and per-agent violation storage.
 */

// ---------------------------------------------------------------------------
// RingBuffer
// ---------------------------------------------------------------------------

/** Fixed-capacity ring buffer. Oldest items evicted when full. */
export interface RingBuffer<T> {
  /** Append an item. Evicts oldest if at capacity. */
  readonly append: (item: T) => void;
  /** Return all items in insertion order (oldest first). */
  readonly items: () => readonly T[];
  /** Current number of items. */
  readonly size: () => number;
  /** Clear all items. */
  readonly clear: () => void;
}

/**
 * Create a fixed-capacity ring buffer.
 *
 * Internal state uses a circular array with head/count tracking.
 * items() returns a snapshot in insertion order.
 */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const buffer: (T | undefined)[] = new Array<T | undefined>(capacity);
  // let: head and count are mutable counters for the circular buffer
  let head = 0;
  let count = 0;

  return {
    append(item: T): void {
      const index = (head + count) % capacity;
      buffer[index] = item;
      if (count < capacity) {
        count += 1;
      } else {
        head = (head + 1) % capacity;
      }
    },

    items(): readonly T[] {
      const result: T[] = [];
      for (let i = 0; i < count; i++) {
        const item = buffer[(head + i) % capacity];
        if (item !== undefined) {
          result.push(item);
        }
      }
      return result;
    },

    size(): number {
      return count;
    },

    clear(): void {
      buffer.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}
