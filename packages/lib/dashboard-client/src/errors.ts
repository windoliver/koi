import { type KoiError, type KoiErrorCode, RETRYABLE_DEFAULTS } from "@koi/core";

interface ClientErrorOptions {
  readonly cause?: unknown;
  /** Override the architecture-doc default — set to `true` for transient failures (network, 5xx). */
  readonly retryable?: boolean;
}

/** Build a KoiError using the architecture-doc retry default for the code. */
export function clientError(
  code: KoiErrorCode,
  message: string,
  options?: ClientErrorOptions,
): KoiError {
  return {
    code,
    message,
    retryable: options?.retryable ?? RETRYABLE_DEFAULTS[code],
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  };
}
