import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

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
