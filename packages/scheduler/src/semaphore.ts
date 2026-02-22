/**
 * Simple counter-based bounded concurrency semaphore.
 */

export interface Semaphore {
  readonly acquire: () => boolean;
  readonly release: () => void;
  readonly available: () => number;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (maxConcurrent < 1) {
    throw new Error("maxConcurrent must be at least 1");
  }

  let inUse = 0; // let: incremented on acquire, decremented on release

  return {
    acquire: () => {
      if (inUse >= maxConcurrent) return false;
      inUse += 1;
      return true;
    },

    release: () => {
      if (inUse > 0) {
        inUse -= 1;
      }
    },

    available: () => maxConcurrent - inUse,
  };
}
