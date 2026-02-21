/**
 * Error types and Result discriminated union.
 */

export type KoiErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "PERMISSION"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "EXTERNAL"
  | "INTERNAL";

export interface KoiError {
  readonly code: KoiErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryable: boolean;
}

export type Result<T, E = KoiError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
