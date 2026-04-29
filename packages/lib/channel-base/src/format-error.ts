/**
 * User-facing error message formatting for channel adapters.
 *
 * Maps KoiErrorCode to fixed, user-friendly messages. Strictly user-safe by
 * construction: the function never reads `error.cause`, stack traces, or —
 * outside of two enumerated exceptions — `error.message` / `error.context`.
 *
 * Exceptions:
 *   - VALIDATION: the message itself is user-relevant input feedback.
 *   - AUTH_REQUIRED: per `KoiError` contract, the operation succeeds after
 *     the user completes OAuth, so we surface the authorization URL from
 *     `error.context.authorizationUrl` when it is a safe http(s) URL.
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
 * Returns `error.context.authorizationUrl` only if it parses as an http(s)
 * URL. Anything else (non-string, javascript:, data:, malformed) is dropped
 * silently so a malicious payload cannot smuggle an unsafe scheme into a
 * user-visible message.
 */
function safeAuthorizationUrl(error: KoiError): string | undefined {
  const raw = error.context?.["authorizationUrl"];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Formats a KoiError into a user-safe string suitable for channel output.
 */
export function formatErrorForChannel(error: KoiError): string {
  if (error.code === "VALIDATION") {
    return `Invalid input: ${error.message}`;
  }
  if (error.code === "AUTH_REQUIRED") {
    const url = safeAuthorizationUrl(error);
    return url === undefined
      ? USER_MESSAGES.AUTH_REQUIRED
      : `${USER_MESSAGES.AUTH_REQUIRED} ${url}`;
  }
  return USER_MESSAGES[error.code];
}
