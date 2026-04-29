/**
 * User-facing error message formatting for channel adapters.
 *
 * Maps KoiErrorCode to fixed, user-friendly messages. Strictly user-safe by
 * construction: the function never reads `error.cause`, `error.context`,
 * stack traces, or — outside of `VALIDATION` — `error.message`. VALIDATION
 * is the one exception because its message is itself the user-relevant
 * input feedback the platform must surface.
 *
 * If callers need raw diagnostics for developer-facing channels (CLI logs,
 * debug panels), they should format `error.code` / `error.message`
 * themselves through their own sanitizer — that path is intentionally not
 * provided here so it cannot be reached accidentally.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

const USER_MESSAGES: Readonly<Record<KoiErrorCode, string>> = {
  VALIDATION: "", // VALIDATION uses error.message directly (user-relevant input feedback)
  NOT_FOUND: "The requested resource was not found.",
  PERMISSION: "You don't have permission to perform this action.",
  CONFLICT: "A conflict occurred. Please try again.",
  RATE_LIMIT: "Too many requests. Please wait a moment.",
  TIMEOUT: "The operation timed out. Please try again.",
  EXTERNAL: "An external service is temporarily unavailable.",
  INTERNAL: "Something went wrong. Please try again later.",
  STALE_REF: "The referenced element is no longer valid. Please try again.",
  AUTH_REQUIRED: "Authorization is required to continue.",
  RESOURCE_EXHAUSTED: "Capacity limit reached. Please try again shortly.",
  UNAVAILABLE: "The service is currently unavailable.",
  HEARTBEAT_TIMEOUT: "The worker stopped responding.",
} as const;

/**
 * Formats a KoiError into a user-safe string suitable for channel output.
 *
 * - VALIDATION shows the original message (user-relevant input feedback).
 * - All other codes return a fixed canned message.
 * - Never leaks `error.cause`, `error.context`, stack traces, or any raw
 *   `error.message` for non-VALIDATION codes.
 */
export function formatErrorForChannel(error: KoiError): string {
  if (error.code === "VALIDATION") {
    return `Invalid input: ${error.message}`;
  }
  return USER_MESSAGES[error.code];
}
