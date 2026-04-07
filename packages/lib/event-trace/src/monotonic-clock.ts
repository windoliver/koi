/**
 * Monotonic clock factory — guarantees strictly increasing timestamps
 * across concurrent middleware observers.
 *
 * Each call returns `max(lastEmitted + 1, baseClock())`, ensuring:
 * - Strict monotonicity even when observers fire within the same millisecond
 * - Timestamps stay close to real wall-clock time
 * - Deterministic testing via injectable base clock
 */
export function createMonotonicClock(baseClock: () => number = Date.now): () => number {
  // let: mutable — tracks the last emitted timestamp for monotonicity guarantee
  let last = 0;
  return (): number => {
    const now = baseClock();
    const next = now > last ? now : last + 1;
    last = next;
    return next;
  };
}
