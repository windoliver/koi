/**
 * Overflow recovery — catches context-overflow errors, force-compacts, retries.
 *
 * Pure utility function: no state, no config dependency.
 * Ported from v1 middleware-compactor.
 *
 * IMPORTANT: Idempotency contract
 * ────────────────────────────────
 * `execute` MUST be idempotent or side-effect-free up to the point where
 * the model/provider call occurs. This wrapper re-invokes `execute()` after
 * `recover()` on overflow errors. If `execute` commits irreversible state
 * (persists messages, emits events, mutates shared state) before the
 * overflow surfaces, that work will be duplicated on retry.
 *
 * Correct usage: wrap only the model/provider call boundary.
 * Wrong usage: wrapping a larger operation that has side effects before
 * the provider call.
 *
 * ```typescript
 * // ✅ Correct — execute is the model call itself
 * wrapWithOverflowRecovery(() => modelCall(request), recover, 2);
 *
 * // ❌ Wrong — side effects before the model call would be replayed
 * wrapWithOverflowRecovery(async () => {
 *   await persistMessage(msg);  // replayed on retry!
 *   return modelCall(request);
 * }, recover, 2);
 * ```
 */

import { isContextOverflowError } from "@koi/errors";

/**
 * Wrap an async operation with overflow recovery.
 *
 * 1. Try `execute()`
 * 2. If overflow error and retries remaining → call `recover()`, retry
 * 3. If non-overflow error or retries exhausted → rethrow
 *
 * @param execute — Must be idempotent. See module-level doc for contract.
 * @param recover — Called between retries to shrink context (e.g., force-compact).
 * @param maxRetries — Maximum retry attempts after overflow.
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
      try {
        await recover();
      } catch (_recoverError: unknown) {
        throw new Error("Recovery failed after context overflow", { cause: error });
      }
    }
  }
}
