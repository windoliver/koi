/**
 * Assertion helpers for Result<T, KoiError> type narrowing in tests.
 *
 * These TypeScript assertion functions eliminate nested `if (result.ok)`
 * guard clauses, making test code more readable and providing better
 * error messages on failure.
 */

import type { KoiError, Result } from "@koi/core/errors";

/**
 * Assert that a Result is ok and narrow its type.
 *
 * @throws Error if the result is an error, including the error code and message.
 */
export function assertOk<T>(
  result: Result<T, KoiError>,
): asserts result is { readonly ok: true; readonly value: T } {
  if (!result.ok) {
    throw new Error(
      `Expected ok result, got error: ${result.error.code} — ${result.error.message}`,
    );
  }
}

/**
 * Assert that a Result is an error and narrow its type.
 *
 * @throws Error if the result is ok, including a JSON representation of the value.
 */
export function assertErr<T>(
  result: Result<T, KoiError>,
): asserts result is { readonly ok: false; readonly error: KoiError } {
  if (result.ok) {
    throw new Error(`Expected error result, got ok with value: ${JSON.stringify(result.value)}`);
  }
}
