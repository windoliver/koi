/**
 * Pressure trend tracker — circular buffer of recent token counts
 * that computes growth-per-turn and estimated turns to compaction.
 *
 * Uses a fixed-size circular buffer (default 10 samples).
 * Ported from v1 middleware-compactor.
 */

import type { ContextPressureTrend } from "@koi/core";

export interface PressureTrendTracker {
  readonly record: (tokenCount: number) => void;
  readonly compute: (threshold: number) => ContextPressureTrend;
  readonly sampleCount: () => number;
}

const DEFAULT_WINDOW_SIZE = 10;

export function createPressureTrendTracker(
  windowSize: number = DEFAULT_WINDOW_SIZE,
): PressureTrendTracker {
  if (windowSize <= 0 || !Number.isInteger(windowSize)) {
    throw new Error(`windowSize must be a positive integer, got ${String(windowSize)}`);
  }

  // let justified: fixed-size ring buffer; in-place index writes are the intended data structure
  const buffer: number[] = new Array<number>(windowSize).fill(0);
  // let justified: write cursor into circular buffer
  let cursor = 0;
  // let justified: total samples recorded (may exceed windowSize)
  let totalRecorded = 0;

  function effectiveCount(): number {
    return Math.min(totalRecorded, windowSize);
  }

  /** Return samples in chronological order (oldest first). */
  function readChronological(): readonly number[] {
    const count = effectiveCount();
    if (count === 0) return [];
    if (totalRecorded <= windowSize) {
      return buffer.slice(0, count);
    }
    // Buffer has wrapped — cursor points to next write position (= oldest entry)
    return [...buffer.slice(cursor), ...buffer.slice(0, cursor)];
  }

  function record(tokenCount: number): void {
    buffer[cursor] = tokenCount;
    cursor = (cursor + 1) % windowSize;
    totalRecorded++;
  }

  function compute(threshold: number): ContextPressureTrend {
    const count = effectiveCount();
    if (count < 2) {
      return {
        growthPerTurn: 0,
        estimatedTurnsToCompaction: -1,
        sampleCount: count,
      };
    }

    const samples = readChronological();
    const first = samples[0] ?? 0;
    const last = samples[count - 1] ?? 0;
    const growthPerTurn = (last - first) / (count - 1);

    if (growthPerTurn <= 0 || last >= threshold) {
      return {
        growthPerTurn,
        estimatedTurnsToCompaction: -1,
        sampleCount: count,
      };
    }

    const remaining = threshold - last;
    const estimatedTurnsToCompaction = Math.ceil(remaining / growthPerTurn);

    return {
      growthPerTurn,
      estimatedTurnsToCompaction,
      sampleCount: count,
    };
  }

  return {
    record,
    compute,
    sampleCount: effectiveCount,
  };
}
