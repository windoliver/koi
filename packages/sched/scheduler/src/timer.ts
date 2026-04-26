import type { Clock } from "./clock.js";

export interface PeriodicTimer extends AsyncDisposable {
  readonly start: () => void;
}

export function createPeriodicTimer(
  intervalMs: number,
  fn: () => void,
  clock: Clock,
): PeriodicTimer {
  let handle: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;

  function schedule(): void {
    if (disposed) return;
    handle = clock.setTimeout(() => {
      if (disposed) return;
      fn();
      schedule();
    }, intervalMs);
  }

  return {
    start(): void {
      schedule();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      disposed = true;
      if (handle !== undefined) clock.clearTimeout(handle);
    },
  };
}
