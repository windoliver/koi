/**
 * Internal error construction helpers.
 *
 * External sink failures are normalized to EXTERNAL; input validation
 * failures become VALIDATION; unexpected bugs become INTERNAL.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function externalError(message: string, cause: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    cause,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
  };
}

export function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

export function internalError(message: string, cause: unknown): KoiError {
  return {
    code: "INTERNAL",
    message,
    cause,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
  };
}
