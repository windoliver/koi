/**
 * KoiEngineError — thin subclass of KoiRuntimeError for L1 engine failures.
 *
 * Preserves instanceof checks + error.name while eliminating ~40 LOC
 * of duplicated logic. Engine errors default to non-retryable (terminal state).
 */

import type { JsonObject, KoiError, KoiErrorCode } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

export class KoiEngineError extends KoiRuntimeError {
  constructor(error: KoiError) {
    super(error);
    this.name = "KoiEngineError";
  }

  /** Engine errors default to non-retryable (terminal state). */
  static override from(
    code: KoiErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly context?: JsonObject;
      readonly retryAfterMs?: number;
    },
  ): KoiEngineError {
    const runtime = KoiRuntimeError.from(code, message, {
      ...options,
      retryable: options?.retryable ?? false,
    });
    return new KoiEngineError(runtime.toKoiError());
  }
}
