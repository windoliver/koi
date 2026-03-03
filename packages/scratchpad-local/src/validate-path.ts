/**
 * Scratchpad path validation utility.
 */

import type { KoiError, Result, ScratchpadPath } from "@koi/core";
import { RETRYABLE_DEFAULTS, SCRATCHPAD_DEFAULTS } from "@koi/core";

/** Validate a scratchpad path against security and length constraints. */
export function validatePath(path: ScratchpadPath): Result<void, KoiError> {
  if (path.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Scratchpad path must not be empty",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (path.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Scratchpad path must not start with "/": "${path}"`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (path.includes("..")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Scratchpad path must not contain "..": "${path}"`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (path.length > SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Scratchpad path exceeds max length (${path.length} > ${SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH})`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: undefined };
}
