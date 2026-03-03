/**
 * Bounded concurrency primitive — limits parallel async operations.
 */

export interface Semaphore {
  readonly acquire: () => Promise<void>;
  readonly release: () => void;
}

/**
 * Creates a semaphore that limits concurrent operations to `max`.
 *
 * @param max - Maximum number of concurrent operations allowed
 */
export function createSemaphore(max: number): Semaphore {
  let current = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (current < max) {
        current++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    },

    release(): void {
      const next = queue.shift();
      if (next !== undefined) {
        next();
      } else {
        current--;
      }
    },
  };
}
