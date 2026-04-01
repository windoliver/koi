/**
 * Periodic timer utility with disposal support.
 */

import type { Clock } from "./clock.js";

export interface PeriodicTimer extends AsyncDisposable {
  readonly stop: () => void;
}

export function createPeriodicTimer(
  clock: Clock,
  intervalMs: number,
  callback: () => void,
): PeriodicTimer {
  if (intervalMs < 1) {
    throw new Error("Interval must be at least 1ms");
  }

  let stopped = false; // let: set to true on stop()
  const id = clock.setInterval(() => {
    if (!stopped) {
      callback();
    }
  }, intervalMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clock.clearInterval(id);
  }

  return {
    stop,
    [Symbol.asyncDispose]: async () => stop(),
  };
}

/**
 * Adaptive timer that adjusts interval between ticks.
 *
 * Uses setTimeout chains (not setInterval) so each tick can compute
 * its own delay based on current conditions (e.g., exponential backoff).
 */
export function createAdaptiveTimer(
  clock: Clock,
  computeInterval: () => number,
  callback: () => void | Promise<void>,
): PeriodicTimer {
  let stopped = false; // let: set to true on stop()
  let timerId: number | undefined; // let: updated on each schedule

  function scheduleNext(): void {
    if (stopped) return;
    const interval = Math.max(1, computeInterval());
    timerId = clock.setTimeout(async () => {
      if (stopped) return;
      try {
        await callback();
      } catch {
        // Swallow — caller is responsible for error handling
      }
      scheduleNext();
    }, interval);
  }

  scheduleNext();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timerId !== undefined) {
      clock.clearTimeout(timerId);
    }
  }

  return {
    stop,
    [Symbol.asyncDispose]: async () => stop(),
  };
}
