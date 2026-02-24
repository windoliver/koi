/**
 * Overflow recovery — catches context-overflow errors, force-compacts, retries.
 *
 * Pure utility function: no state, no config dependency. The caller provides
 * execute (the model call) and recover (force-compact to shrink context).
 */

import { isContextOverflowError } from "@koi/errors";

/**
 * Wrap an async operation with overflow recovery.
 *
 * 1. Try `execute()`
 * 2. If overflow error and retries remaining → call `recover()`, retry
 * 3. If non-overflow error or retries exhausted → rethrow
 */
export async function wrapWithOverflowRecovery<T>(
  execute: () => Promise<T>,
  recover: () => Promise<void>,
  maxRetries: number,
): Promise<T> {
  // let required: tracks remaining retry attempts, decremented on each overflow recovery
  let retriesLeft = maxRetries;

  for (;;) {
    try {
      return await execute();
    } catch (error: unknown) {
      if (!isContextOverflowError(error) || retriesLeft <= 0) {
        throw error;
      }
      retriesLeft--;
      await recover();
    }
  }
}
