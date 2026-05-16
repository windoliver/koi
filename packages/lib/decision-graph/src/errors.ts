import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

export function externalError(message: string, cause?: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    ...(cause !== undefined ? { cause } : {}),
  };
}
