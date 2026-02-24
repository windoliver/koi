/**
 * Error types, Result discriminated union, and retry defaults.
 *
 * ## Exhaustive error code handling
 *
 * Use the `never` pattern to ensure all codes are handled:
 *
 * ```typescript
 * function handle(code: KoiErrorCode): string {
 *   switch (code) {
 *     case "VALIDATION": return "bad input";
 *     case "NOT_FOUND":  return "missing";
 *     // ... all 8 codes ...
 *     default: {
 *       const _exhaustive: never = code;
 *       throw new Error(`Unhandled code: ${String(_exhaustive)}`);
 *     }
 *   }
 * }
 * ```
 */

import type { JsonObject } from "./common.js";

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
  /** Structured metadata for programmatic handling (e.g., resourceId, limit). */
  readonly context?: JsonObject;
  /** Hint for retry middleware — non-negative milliseconds to wait before retrying. */
  readonly retryAfterMs?: number;
}

/**
 * Default retryability per error code. Derived from the architecture doc's
 * error taxonomy. EXTERNAL defaults to `false` — callers should override
 * based on the specific external failure.
 */
export const RETRYABLE_DEFAULTS: Readonly<Record<KoiErrorCode, boolean>> = Object.freeze({
  VALIDATION: false,
  NOT_FOUND: false,
  PERMISSION: false,
  CONFLICT: true,
  RATE_LIMIT: true,
  TIMEOUT: true,
  EXTERNAL: false,
  INTERNAL: false,
});

export type Result<T, E = KoiError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Standard signature for backend error mappers.
 * Each L2 backend adapter should export a function matching this shape.
 */
export type BackendErrorMapper = (error: unknown, context: string) => KoiError;
