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
 *     // ... all 9 codes ...
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
  | "INTERNAL"
  /**
   * A cached reference (browser element ref, DB cursor, WebSocket token, etc.)
   * has become invalid because the underlying resource changed or was replaced.
   * The caller must re-acquire a fresh reference before retrying the operation.
   *
   * Distinct from NOT_FOUND (which means the resource never existed or was
   * permanently deleted). STALE_REF means the resource likely still exists
   * but the handle pointing to it is no longer valid.
   *
   * Common browser automation pattern: call browser_snapshot to obtain fresh
   * [ref=eN] markers, then retry the action with the new ref.
   */
  | "STALE_REF";

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
  STALE_REF: false,
});

export type Result<T, E = KoiError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Standard signature for backend error mappers.
 * Each L2 backend adapter should export a function matching this shape.
 */
export type BackendErrorMapper = (error: unknown, context: string) => KoiError;
