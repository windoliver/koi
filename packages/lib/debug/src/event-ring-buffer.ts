import type { EngineEvent } from "@koi/core";

/** Bounded circular buffer for EngineEvent history. */
export interface EventRingBuffer {
  readonly push: (event: EngineEvent) => void;
  /** Get the most recent N events, oldest first. */
  readonly tail: (limit?: number) => readonly EngineEvent[];
  readonly size: () => number;
  readonly capacity: () => number;
  readonly clear: () => void;
}

/** Create a bounded ring buffer for EngineEvent history. */
export function createEventRingBuffer(maxSize: number): EventRingBuffer {
  // let justified: mutable circular buffer, write head, and total count
  const buffer: Array<EngineEvent | undefined> = new Array<EngineEvent | undefined>(maxSize).fill(
    undefined,
  );
  let head = 0;
  let totalWritten = 0;

  return {
    push: (event) => {
      buffer[head] = event;
      head = (head + 1) % maxSize;
      totalWritten += 1;
    },

    tail: (limit) => {
      const count = Math.min(totalWritten, maxSize);
      const effectiveLimit = limit !== undefined ? Math.min(limit, count) : count;
      const result: EngineEvent[] = [];

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
