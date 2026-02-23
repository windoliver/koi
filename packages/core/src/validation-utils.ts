/**
 * Validation utilities — pure functions for L0 type safety.
 *
 * isProcessState: runtime type guard matching the ProcessState union.
 * validateNonEmpty: shared validation helper for non-empty string fields.
 */

import type { ProcessState } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import { RETRYABLE_DEFAULTS } from "./errors.js";

// ---------------------------------------------------------------------------
// ProcessState type guard
// ---------------------------------------------------------------------------

const VALID_PROCESS_STATES: ReadonlySet<string> = new Set<ProcessState>([
  "created",
  "running",
  "waiting",
  "suspended",
  "terminated",
]);

/**
 * Runtime type guard for ProcessState.
 * Returns true if the value is a valid ProcessState string.
 */
export function isProcessState(value: string): value is ProcessState {
  return VALID_PROCESS_STATES.has(value);
}

// ---------------------------------------------------------------------------
// Non-empty string validation
// ---------------------------------------------------------------------------

/**
 * Validate that a string is non-empty.
 * Returns a VALIDATION error Result if the string is empty.
 */
export function validateNonEmpty(value: string, name: string): Result<void, KoiError> {
  if (value === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `${name} must not be empty`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: undefined };
}
