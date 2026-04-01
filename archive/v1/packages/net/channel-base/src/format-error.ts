/**
 * User-facing error message formatting for channel adapters.
 *
 * Maps KoiErrorCode to safe, user-friendly messages that never leak
 * internal details (cause, context, stack traces).
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

export interface FormatErrorOptions {
  readonly verbose?: boolean;
}

const USER_MESSAGES: Readonly<Record<KoiErrorCode, string>> = {
  VALIDATION: "", // uses error.message directly (user-relevant input feedback)
  NOT_FOUND: "The requested resource was not found.",
  PERMISSION: "You don't have permission to perform this action.",
  CONFLICT: "A conflict occurred. Please try again.",
  RATE_LIMIT: "Too many requests. Please wait a moment.",
  TIMEOUT: "The operation timed out. Please try again.",
  EXTERNAL: "An external service is temporarily unavailable.",
  INTERNAL: "Something went wrong. Please try again later.",
  STALE_REF: "The referenced element is no longer valid. Please try again.",
} as const;

/**
 * Formats a KoiError into a user-safe string suitable for channel output.
 *
 * - VALIDATION always shows the original message (it's user-relevant input feedback)
 * - All other codes use a fixed user-friendly message
 * - Verbose mode appends technical details for developer-facing channels (CLI)
 * - Never leaks error.cause, error.context, or stack traces
 */
export function formatErrorForChannel(error: KoiError, options?: FormatErrorOptions): string {
  const verbose = options?.verbose ?? false;

  // VALIDATION: always show original message (it's user-relevant input feedback)
  if (error.code === "VALIDATION") {
    return `Invalid input: ${error.message}`;
  }

  const base = USER_MESSAGES[error.code];

  if (!verbose) return base;

  // Verbose: append technical details
  if (error.code === "RATE_LIMIT" && error.retryAfterMs !== undefined) {
    return `${base} (retry after ${error.retryAfterMs}ms)`;
  }
  return `${base} (${error.message})`;
}
