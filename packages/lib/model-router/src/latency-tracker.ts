/**
 * Per-target latency tracker using a fixed-size circular buffer.
 *
 * Stores the last WINDOW_SIZE samples (default 1000) per target.
 * Computes p50/p95 on demand by sorting the buffer — O(N log N) at read time,
 * O(1) at write time. At 1000 samples × 8 bytes = 8KB per target — negligible.
 */

const WINDOW_SIZE = 1_000;

export interface LatencyPercentiles {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface LatencyTracker {
  /** Record a new latency sample in milliseconds. */
  readonly record: (ms: number) => void;
  /**
   * Compute p50/p95 from the current buffer.
   * Returns undefined if fewer than 2 samples have been recorded.
   */
  readonly getPercentiles: () => LatencyPercentiles | undefined;
  /** Current sample count (capped at WINDOW_SIZE). */
  readonly sampleCount: () => number;
}

/**
 * Creates a latency tracker with a fixed circular buffer.
 *
 * @param windowSize - Number of samples to retain. Defaults to 1000.
 */
export function createLatencyTracker(windowSize: number = WINDOW_SIZE): LatencyTracker {
  const buffer: number[] = new Array<number>(windowSize).fill(0);
  // let: ring-buffer write position, justified — encapsulated mutable counter
  let writeIndex = 0;
  let totalRecorded = 0;

  return {
    record(ms: number): void {
      buffer[writeIndex % windowSize] = ms;
      writeIndex++;
      totalRecorded++;
    },

    getPercentiles(): LatencyPercentiles | undefined {
      if (totalRecorded < 2) return undefined;

      const count = Math.min(totalRecorded, windowSize);
      // Slice to only the populated portion — avoid sorting trailing zeros
      const samples = buffer.slice(0, count).sort((a, b) => a - b);

      const p50Index = Math.floor(count * 0.5);
      const p95Index = Math.floor(count * 0.95);

      return {
        p50Ms: samples[p50Index] ?? 0,
        p95Ms: samples[p95Index] ?? 0,
      };
    },

    sampleCount(): number {
      return Math.min(totalRecorded, windowSize);
    },
  };
}
