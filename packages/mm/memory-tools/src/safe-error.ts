/**
 * Sanitized error responses for tool handlers.
 *
 * Maps backend failures and exceptions to stable, user-safe messages.
 * Raw error details (paths, OS errors) are not exposed to the model.
 */

import type { KoiError } from "@koi/core";

/** Stable error messages by KoiError code. */
const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: "Memory not found",
  VALIDATION: "Invalid input",
  CONFLICT: "Conflicting operation",
  RATE_LIMIT: "Too many requests",
  TIMEOUT: "Operation timed out",
};

/** Map a KoiError to a sanitized tool error response. */
export function safeBackendError(
  error: KoiError,
  fallback: string,
): { readonly error: string; readonly code: string } {
  const message = SAFE_MESSAGES[error.code] ?? fallback;
  return { error: message, code: error.code };
}

/** Map a caught exception to a sanitized tool error response. */
export function safeCatchError(fallback: string): {
  readonly error: string;
  readonly code: string;
} {
  return { error: fallback, code: "INTERNAL" };
}
