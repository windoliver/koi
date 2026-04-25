export interface Semaphore {
  readonly tryAcquire: () => boolean;
  readonly release: () => void;
  readonly available: () => number;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  let inUse = 0;
  return {
    tryAcquire(): boolean {
      if (inUse >= maxConcurrent) return false;
      inUse++;
      return true;
    },
    release(): void {
      if (inUse > 0) inUse--;
    },
    available(): number {
      return maxConcurrent - inUse;
    },
  };
}
