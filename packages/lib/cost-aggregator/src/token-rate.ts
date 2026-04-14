/**
 * Token rate tracker — sliding window tokens-per-second calculation.
 *
 * Maintains a circular buffer of timestamped token samples.
 * Rate is computed over the most recent window (default: 30 seconds).
 */

/** Default window size in milliseconds (30 seconds). */
const DEFAULT_WINDOW_MS = 30_000;

/** Maximum samples retained in the sliding window. */
const MAX_SAMPLES = 1000;

interface TokenSample {
  readonly timestamp: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface TokenRateTracker {
  /** Record a token sample (call after each model response). */
  readonly record: (inputTokens: number, outputTokens: number) => void;
  /** Current input tokens per second over the sliding window. */
  readonly inputPerSecond: () => number;
  /** Current output tokens per second over the sliding window. */
  readonly outputPerSecond: () => number;
  /** Reset all samples. */
  readonly clear: () => void;
}

/**
 * Create a token rate tracker with a sliding time window.
 *
 * @param windowMs - Sliding window duration. Default: 30,000ms (30s).
 */
export function createTokenRateTracker(windowMs: number = DEFAULT_WINDOW_MS): TokenRateTracker {
  const samples: TokenSample[] = [];
  // let: justified — mutable write cursor for circular buffer
  let head = 0;
  let count = 0;

  function pruneOld(now: number): void {
    const cutoff = now - windowMs;
    // Remove samples older than the window. Since samples are appended
    // chronologically, scan from the oldest (logical start of ring).
    while (count > 0) {
      const oldest = samples[(head - count + MAX_SAMPLES) % MAX_SAMPLES];
      if (oldest !== undefined && oldest.timestamp < cutoff) {
        count -= 1;
      } else {
        break;
      }
    }
  }

  function computeRate(now: number, field: "inputTokens" | "outputTokens"): number {
    pruneOld(now);
    if (count < 2) return 0;

    const start = (head - count + MAX_SAMPLES) % MAX_SAMPLES;
    const oldest = samples[start];
    if (oldest === undefined) return 0;

    const elapsed = (now - oldest.timestamp) / 1000;
    if (elapsed <= 0) return 0;

    // Sum all tokens in the window
    let total = 0;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % MAX_SAMPLES;
      const s = samples[idx];
      if (s !== undefined) total += s[field];
    }

    return total / elapsed;
  }

  return {
    record(inputTokens: number, outputTokens: number): void {
      const now = Date.now();
      const sample: TokenSample = { timestamp: now, inputTokens, outputTokens };
      if (samples.length < MAX_SAMPLES) {
        samples.push(sample);
      } else {
        samples[head % MAX_SAMPLES] = sample;
      }
      head = (head + 1) % MAX_SAMPLES;
      if (count < MAX_SAMPLES) count += 1;
    },

    inputPerSecond(): number {
      return computeRate(Date.now(), "inputTokens");
    },

    outputPerSecond(): number {
      return computeRate(Date.now(), "outputTokens");
    },

    clear(): void {
      samples.length = 0;
      head = 0;
      count = 0;
    },
  };
}
