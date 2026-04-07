/**
 * Monotonic clock factory — guarantees strictly increasing timestamps
 * across concurrent middleware observers.
 *
 * Each call returns `max(lastEmitted + 1, baseClock())`, ensuring:
 * - Strict monotonicity even when observers fire within the same millisecond
 * - Timestamps stay close to real wall-clock time
 * - Deterministic testing via injectable base clock
 *
 * Drift behavior: during a burst of N events within one millisecond,
 * timestamps advance by +1ms each (max drift = N ms). Once the burst
 * ends and the base clock advances past `last`, timestamps resync to
 * wall-clock time. Typical agent runs produce < 100 steps/turn, so
 * max drift is ~100ms — negligible for retention (days) and replay.
 */
export function createMonotonicClock(baseClock: () => number = Date.now): () => number {
  // let: mutable — tracks the last emitted timestamp for monotonicity guarantee.
  // -Infinity ensures the first call returns baseClock() unmodified.
  let last = -Infinity;
  return (): number => {
    const now = baseClock();
    const next = now > last ? now : last + 1;
    last = next;
    return next;
  };
}
