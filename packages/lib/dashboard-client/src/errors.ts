import { type KoiError, type KoiErrorCode, RETRYABLE_DEFAULTS } from "@koi/core";

/** Build a KoiError using the architecture-doc retry default for the code. */
export function clientError(code: KoiErrorCode, message: string, cause?: unknown): KoiError {
  return {
    code,
    message,
    retryable: RETRYABLE_DEFAULTS[code],
    ...(cause === undefined ? {} : { cause }),
  };
}
