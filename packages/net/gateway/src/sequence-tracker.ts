/**
 * SequenceTracker: ordering + deduplication via a sliding window.
 *
 * Maintains a window of expected sequence numbers. Frames arriving
 * in-order are accepted immediately. Out-of-order frames within the
 * window are buffered and released once the gap fills. Duplicates
 * (same seq already seen) are rejected.
 */

import type { GatewayFrame } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcceptResult = "accepted" | "duplicate" | "out_of_window" | "buffered";

export interface SequenceTracker {
  /**
   * Submit a frame for ordering/dedup.
   * Returns the disposition and any frames that became ready (in order).
   */
  readonly accept: (frame: GatewayFrame) => {
    readonly result: AcceptResult;
    readonly ready: readonly GatewayFrame[];
  };
  /** The next expected sequence number. */
  readonly expectedSeq: () => number;
  /** Number of frames currently buffered (waiting for gap fill). */
  readonly bufferedCount: () => number;
  /** Reset tracker state (e.g. on reconnect). */
  readonly reset: (startSeq?: number) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSequenceTracker(windowSize: number): SequenceTracker {
  let nextExpected = 0;
  // Buffered out-of-order frames, keyed by seq
  const buffer = new Map<number, GatewayFrame>();
  // Map of seen IDs → seq within the current window for dedup + precise pruning
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

      // Already processed (seq < nextExpected)
      if (seq < nextExpected) {
        return { result: "duplicate", ready: [] };
      }

      // Beyond the window
      if (seq >= nextExpected + windowSize) {
        return { result: "out_of_window", ready: [] };
      }

      // Duplicate by ID within the window
      if (seenIds.has(id)) {
        return { result: "duplicate", ready: [] };
      }

      // Reject if a different frame already occupies this seq in the buffer
      if (buffer.has(seq)) {
        return { result: "duplicate", ready: [] };
      }

      seenIds.set(id, seq);

      // In-order: accept immediately and flush any buffered followers
      if (seq === nextExpected) {
        nextExpected++;
        const flushed = flushReady();
        return { result: "accepted", ready: [frame, ...flushed] };
      }

      // Out-of-order but within window: buffer it
      buffer.set(seq, frame);
      return { result: "buffered", ready: [] };
    },

    expectedSeq(): number {
      return nextExpected;
    },

    bufferedCount(): number {
      return buffer.size;
    },

    reset(startSeq = 0): void {
      nextExpected = startSeq;
      buffer.clear();
      seenIds.clear();
    },
  };
}
