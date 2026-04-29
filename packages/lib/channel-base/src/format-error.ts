/**
 * User-facing error message formatting for channel adapters.
 *
 * Maps KoiErrorCode to fixed, user-friendly messages. Strictly user-safe by
 * construction: never reads `error.cause`, `error.context`, stack traces, or
 * — outside of `VALIDATION` — `error.message`. VALIDATION is the one
 * exception because its message is itself the user-relevant input feedback;
 * the message is sanitized through `sanitizeValidationMessage` before being
 * concatenated into channel output.
 *
 * Notably this helper does NOT surface authorization URLs for
 * `AUTH_REQUIRED`. The channel-base layer cannot validate that a URL in
 * `error.context` is the configured OAuth issuer for the current tenant —
 * embedding raw URLs from arbitrary error sources would be a phishing
 * primitive. Adapters that need to render an OAuth handoff must read
 * structured auth metadata themselves and validate it against their own
 * trust configuration before showing a clickable link.
 *
 * If callers need raw diagnostics for developer-facing channels (CLI logs,
 * debug panels), they should format `error.code` / `error.message`
 * themselves through their own sanitizer — that path is intentionally not
 * provided here so it cannot be reached accidentally.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

const VALIDATION_MAX_LEN = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: regex precisely targets ASCII control characters to strip them
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const MARKDOWN_LINK_DELIMS = /[[\]()<>]/g;

/**
 * Sanitizes the VALIDATION message before it is concatenated into channel
 * output. The message originates from validators whose text we don't fully
 * control, so we:
 *   - replace ASCII control characters with spaces — many channel transports
 *     treat them as protocol delimiters or formatting escapes;
 *   - strip the markdown autolink/inline-link delimiters `[`, `]`, `(`,
 *     `)`, `<`, `>` so a hostile validator string cannot construct a
 *     clickable link in markdown-rendering channels;
 *   - cap the length so a pathological message cannot pin a channel.
 *
 * Per-channel adapters do their own format-specific escaping on top of this
 * coarse channel-base safety net.
 */
function sanitizeValidationMessage(raw: string): string {
  const stripped = raw.replace(CONTROL_CHARS, " ").replace(MARKDOWN_LINK_DELIMS, "");
  return stripped.length > VALIDATION_MAX_LEN
    ? `${stripped.slice(0, VALIDATION_MAX_LEN)}…`
    : stripped;
}

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
 */
export function formatErrorForChannel(error: KoiError): string {
  if (error.code === "VALIDATION") {
    return `Invalid input: ${sanitizeValidationMessage(error.message)}`;
  }
  return USER_MESSAGES[error.code];
}
