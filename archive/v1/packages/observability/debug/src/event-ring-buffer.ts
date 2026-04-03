/**
 * Bounded ring buffer for EngineEvent history.
 *
 * Fixed-size circular buffer that overwrites oldest events when full.
 */

import type { EngineEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventRingBuffer {
  /** Push an event into the buffer. Overwrites oldest if full. */
  readonly push: (event: EngineEvent) => void;
  /** Get the most recent N events (newest last). */
  readonly tail: (limit?: number) => readonly EngineEvent[];
  /** Current number of events in the buffer. */
  readonly size: () => number;
  /** Maximum capacity. */
  readonly capacity: () => number;
  /** Clear all events. */
  readonly clear: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a bounded ring buffer for EngineEvent history. */
export function createEventRingBuffer(maxSize: number): EventRingBuffer {
  // let justified: mutable circular buffer array and write head
  const buffer: Array<EngineEvent | undefined> = new Array(maxSize).fill(undefined);
  // let justified: write head position in the circular buffer
  let head = 0;
  // let justified: total events written (may exceed maxSize)
  let totalWritten = 0;

  return {
    push: (event) => {
      buffer[head % maxSize] = event;
      head = (head + 1) % maxSize;
      totalWritten += 1;
    },

    tail: (limit) => {
      const count = Math.min(totalWritten, maxSize);
      const effectiveLimit = limit !== undefined ? Math.min(limit, count) : count;
      const result: EngineEvent[] = [];

      // Read from oldest to newest
      const startIndex = totalWritten <= maxSize ? 0 : head;
      const skipCount = count - effectiveLimit;

      for (let i = 0; i < effectiveLimit; i++) {
        const idx = (startIndex + skipCount + i) % maxSize;
        const event = buffer[idx];
        if (event !== undefined) {
          result.push(event);
        }
      }

      return result;
    },

    size: () => Math.min(totalWritten, maxSize),

    capacity: () => maxSize,

    clear: () => {
      buffer.fill(undefined);
      head = 0;
      totalWritten = 0;
    },
  };
}
