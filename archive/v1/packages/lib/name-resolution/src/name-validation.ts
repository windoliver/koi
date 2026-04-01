/**
 * Name validation for ANS records.
 *
 * Names must start with a lowercase letter, followed by lowercase
 * alphanumeric characters and hyphens. No colons (reserved for
 * composite key separator).
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Valid ANS name pattern: lowercase letter, then lowercase alphanumeric + hyphens. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Maximum length for an ANS name. */
const MAX_NAME_LENGTH = 128;

/** Validate an ANS name. Returns the validated name on success, VALIDATION error on failure. */
export function validateName(name: string): Result<string, KoiError> {
  if (name.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Name must not be empty",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name must be at most ${MAX_NAME_LENGTH} characters, got ${name.length}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid name "${name}": must start with a lowercase letter, followed by lowercase alphanumeric characters and hyphens`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: name };
}
