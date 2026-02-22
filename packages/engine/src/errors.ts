/**
 * KoiEngineError — concrete error class for L1 engine failures.
 *
 * Extends Error with structured KoiErrorCode, retryable flag, and optional context.
 * Used by guards and the engine loop to signal termination or invalid state.
 */

import type { JsonObject, KoiError, KoiErrorCode } from "@koi/core";

export class KoiEngineError extends Error {
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
  readonly context: JsonObject | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(error: KoiError) {
    super(error.message, { cause: error.cause });
    this.name = "KoiEngineError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.context = error.context;
    this.retryAfterMs = error.retryAfterMs;
  }

  /** Create a KoiEngineError from code and message with sensible defaults. */
  static from(
    code: KoiErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly context?: JsonObject;
      readonly retryAfterMs?: number;
    },
  ): KoiEngineError {
    const error: KoiError = {
      code,
      message,
      retryable: options?.retryable ?? false,
    };

    // Build the full error object, only including optional fields when defined
    // to satisfy exactOptionalPropertyTypes
    const fullError: KoiError = {
      ...error,
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
      ...(options?.context !== undefined ? { context: options.context } : {}),
      ...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    };

    return new KoiEngineError(fullError);
  }
}
