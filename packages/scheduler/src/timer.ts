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
