/**
 * Timeout-guarded executor wrapper.
 *
 * Wraps a SandboxExecutor with a configurable maximum timeout.
 * The effective timeout is the minimum of the caller's timeout and the configured max.
 */

import type { SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";

/**
 * Create a SandboxExecutor that enforces a maximum timeout.
 *
 * Wraps execute() with Promise.race against a timeout promise.
 * The effective timeout is Math.min(callerTimeout, maxTimeoutMs).
 */
export function createTimeoutGuardedExecutor(
  inner: SandboxExecutor,
  maxTimeoutMs: number,
): SandboxExecutor {
  return {
    execute: async (
      code: string,
      input: unknown,
      timeoutMs: number,
      context?,
    ): Promise<
      | { readonly ok: true; readonly value: SandboxResult }
      | { readonly ok: false; readonly error: SandboxError }
    > => {
      const effectiveTimeout = Math.min(timeoutMs, maxTimeoutMs);

      const result = await Promise.race([
        inner.execute(code, input, effectiveTimeout, context),
        createTimeoutPromise(effectiveTimeout),
      ]);

      return result;
    },
  };
}

function createTimeoutPromise(
  timeoutMs: number,
): Promise<{ readonly ok: false; readonly error: SandboxError }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Execution timed out after ${String(timeoutMs)}ms`,
          durationMs: timeoutMs,
        },
      });
    }, timeoutMs);
  });
}
