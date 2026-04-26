/**
 * SequenceTracker: ordering + deduplication via a sliding window.
 *
 * In-order frames are accepted immediately. Out-of-order frames within the
 * window are buffered and released once the gap fills. Duplicates (same seq
 * or same frame ID already seen) are rejected.
 */

import type { GatewayFrame } from "./types.js";

export type AcceptResult = "accepted" | "duplicate" | "out_of_window" | "buffered";

export interface SequenceTracker {
  readonly accept: (frame: GatewayFrame) => {
    readonly result: AcceptResult;
    readonly ready: readonly GatewayFrame[];
  };
  readonly expectedSeq: () => number;
  readonly bufferedCount: () => number;
  /** Returns frames currently held in the reorder buffer (not yet dispatchable). */
  readonly bufferedFrames: () => readonly GatewayFrame[];
  readonly reset: (startSeq?: number) => void;
}

export function createSequenceTracker(windowSize: number): SequenceTracker {
  let nextExpected = 0;
  const buffer = new Map<number, GatewayFrame>();
  const seenIds = new Map<string, number>();

  function flushReady(): readonly GatewayFrame[] {
    const ready: GatewayFrame[] = [];
    let frame = buffer.get(nextExpected);
    while (frame !== undefined) {
      buffer.delete(nextExpected);
      ready.push(frame);
      nextExpected++;
      frame = buffer.get(nextExpected);
    }
    pruneSeenIds();
    return ready;
  }

  function pruneSeenIds(): void {
    const cutoff = nextExpected - windowSize;
    if (cutoff <= 0) return;
    for (const [id, seq] of seenIds) {
      if (seq < cutoff) seenIds.delete(id);
    }
  }

  return {
    accept(frame: GatewayFrame): {
      readonly result: AcceptResult;
      readonly ready: readonly GatewayFrame[];
    } {
      const { seq, id } = frame;

      if (seq < nextExpected) {
        return { result: "duplicate", ready: [] };
      }
      if (seq >= nextExpected + windowSize) {
        return { result: "out_of_window", ready: [] };
      }
      if (seenIds.has(id)) {
        return { result: "duplicate", ready: [] };
      }
      if (buffer.has(seq)) {
        return { result: "duplicate", ready: [] };
      }

      seenIds.set(id, seq);

      if (seq === nextExpected) {
        nextExpected++;
        const flushed = flushReady();
        return { result: "accepted", ready: [frame, ...flushed] };
      }

      buffer.set(seq, frame);
      return { result: "buffered", ready: [] };
    },

    expectedSeq(): number {
      return nextExpected;
    },

    bufferedCount(): number {
      return buffer.size;
    },

    bufferedFrames(): readonly GatewayFrame[] {
      return [...buffer.values()].sort((a, b) => a.seq - b.seq);
    },

    reset(startSeq = 0): void {
      nextExpected = startSeq;
      buffer.clear();
      seenIds.clear();
    },
  };
}
