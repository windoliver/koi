/**
 * KoiRuntimeError — concrete Error subclass wrapping KoiError for L2 packages.
 *
 * Provides:
 * - Stack traces for debugging
 * - instanceof checks in catch blocks
 * - Structured KoiError fields (code, retryable, context)
 */

import type { JsonObject, KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export class KoiRuntimeError extends Error {
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
  readonly context: JsonObject | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(error: KoiError) {
    super(error.message, error.cause !== undefined ? { cause: error.cause } : {});
    this.name = "KoiRuntimeError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.context = error.context;
    this.retryAfterMs = error.retryAfterMs;
  }

  /** Convenience factory: create from code + message with RETRYABLE_DEFAULTS. */
  static from(
    code: KoiErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly context?: JsonObject;
      readonly retryAfterMs?: number;
    },
  ): KoiRuntimeError {
    const koiError: KoiError = {
      code,
      message,
      retryable: options?.retryable ?? RETRYABLE_DEFAULTS[code],
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
      ...(options?.context !== undefined ? { context: options.context } : {}),
      ...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    };
    return new KoiRuntimeError(koiError);
  }

  /** Convert to a plain KoiError data object. */
  toKoiError(): KoiError {
    const base: KoiError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    return {
      ...base,
      ...(this.cause !== undefined ? { cause: this.cause } : {}),
      ...(this.context !== undefined ? { context: this.context } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}
