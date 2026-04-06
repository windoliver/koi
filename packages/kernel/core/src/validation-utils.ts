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
  "idle",
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
 * Allowlist pattern for session IDs used as filesystem path components.
 * Only alphanumeric characters, hyphens, and underscores — max 128 chars.
 */
const SESSION_ID_PATH_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate that a SessionId string is safe to use as a filesystem path component.
 *
 * Uses an allowlist (/^[a-zA-Z0-9_-]{1,128}$/) rather than a denylist.
 * Call this at any boundary where a session ID will be used to construct a file path.
 * Path injection is structurally impossible for IDs that pass this check.
 */
export function validateSessionIdSyntax(
  id: string,
  name: string = "Session ID",
): Result<void, KoiError> {
  if (!SESSION_ID_PATH_PATTERN.test(id)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `${name} must match /^[a-zA-Z0-9_-]{1,128}$/ (got: "${id.slice(0, 40)}")`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: undefined };
}

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
