/**
 * Bounded ring buffer for message deduplication.
 *
 * Replaces unbounded Set<string> with a fixed-capacity circular buffer.
 * At 10K capacity the memory footprint is ~400KB max.
 */

/** Deduplication buffer with bounded memory. */
export interface SeenBuffer {
  readonly has: (id: string) => boolean;
  readonly add: (id: string) => void;
  readonly clear: () => void;
}

/**
 * Create a bounded ring buffer for tracking seen message IDs.
 *
 * - `has()` scans the array (10K strings is trivially fast)
 * - `add()` overwrites at write index, advances modulo capacity
 * - `clear()` resets all slots and the write pointer
 */
export function createSeenBuffer(capacity: number): SeenBuffer {
  if (capacity < 1) {
    throw new Error(`SeenBuffer capacity must be >= 1, got ${String(capacity)}`);
  }

  const buffer: Array<string | undefined> = new Array<string | undefined>(capacity).fill(undefined);
  // let justified: write pointer advances on each add()
  let writeIndex = 0;

  const has = (id: string): boolean => buffer.includes(id);

  const add = (id: string): void => {
    buffer[writeIndex] = id;
    writeIndex = (writeIndex + 1) % capacity;
  };

  const clear = (): void => {
    buffer.fill(undefined);
    writeIndex = 0;
  };

  return { has, add, clear };
}
