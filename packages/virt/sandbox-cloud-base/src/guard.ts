/**
 * Destroyed-guard factory — prevents method calls after destroy().
 *
 * Cloud sandbox instances are stateful remote resources. Once destroyed,
 * all subsequent operations must fail immediately with a clear error.
 */

export interface DestroyGuard {
  /** Throws if destroyed. Call at the top of every instance method. */
  readonly check: (method: string) => void;
  /** Mark as destroyed. Idempotent. */
  readonly markDestroyed: () => void;
  /** Whether destroy has been called. */
  readonly isDestroyed: () => boolean;
}

/**
 * Create a destroyed-guard for a sandbox instance.
 *
 * @param name - Adapter name (e.g., "e2b", "vercel") for error messages
 */
export function createDestroyGuard(name: string): DestroyGuard {
  let destroyed = false;

  return {
    check: (method: string): void => {
      if (destroyed) {
        throw new Error(`${name}: cannot call ${method}() after destroy()`);
      }
    },
    markDestroyed: (): void => {
      destroyed = true;
    },
    isDestroyed: (): boolean => destroyed,
  };
}
