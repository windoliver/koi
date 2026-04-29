/**
 * User-facing error formatting for channel adapters.
 *
 * Returns a discriminated union so adapters handle the three trust classes
 * explicitly:
 *
 *   - `kind: "text"` — canned, fully user-safe string. Concatenate into
 *     channel output as-is.
 *   - `kind: "validation"` — the validator's own message is user-relevant
 *     input feedback. The helper provides a pre-sanitized `safeText` (no
 *     control chars, no markdown link delimiters, scheme/`www.` URLs
 *     redacted, length-capped). Adapters MAY use `safeText` directly, OR
 *     re-render the raw `rawMessage` through their own format-specific
 *     escaper if they need a stricter or looser policy than the coarse
 *     default.
 *   - `kind: "auth-required"` — the channel-base layer cannot decide
 *     whether `error.context.authorizationUrl` (or any other auth handoff
 *     metadata) belongs to the configured OAuth issuer for the current
 *     tenant. Adapters MUST inspect the original `error` themselves and
 *     validate any URL/handoff against their own trust configuration
 *     before showing a clickable link. The canned `safeText` is provided
 *     as a fallback for adapters that have no auth UX path; using it
 *     leaves the user without a recovery action.
 *
 * The function never reads `error.cause`, stack traces, or — outside of
 * the cases above — `error.message` / `error.context`.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

const VALIDATION_MAX_LEN = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: regex precisely targets ASCII control characters to strip them
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const MARKDOWN_LINK_DELIMS = /[[\]()<>]/g;
const URL_LIKE = /\b(?:https?|ftps?|wss?):\/\/\S+/gi;
const WWW_LIKE = /\bwww\.\S+/gi;

function sanitizeValidationMessage(raw: string): string {
  const stripped = raw
    .replace(CONTROL_CHARS, " ")
    .replace(URL_LIKE, "link removed")
    .replace(WWW_LIKE, "link removed")
    .replace(MARKDOWN_LINK_DELIMS, "");
  return stripped.length > VALIDATION_MAX_LEN
    ? `${stripped.slice(0, VALIDATION_MAX_LEN)}…`
    : stripped;
}

/**
 * Fallback message for unknown error codes — version skew (newer producer,
 * deserialized remote error, forward-compat path) must never collapse to
 * undefined or empty user output.
 */
const UNKNOWN_CODE_MESSAGE = "Something went wrong. Please try again later.";

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

export type ChannelErrorOutput =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "validation";
      /** Sanitized text safe to concatenate into any channel transport. */
      readonly safeText: string;
      /** Raw validator message; adapters may re-escape this themselves. */
      readonly rawMessage: string;
    }
  | {
      readonly kind: "auth-required";
      /** Canned fallback when the adapter has no auth UX path. */
      readonly safeText: string;
      /** Original error for the adapter to inspect for auth metadata. */
      readonly error: KoiError;
    };

/**
 * Formats a KoiError for channel output. See module docstring for the
 * three discriminants and the trust contract on each.
 */
export function formatErrorForChannel(error: KoiError): ChannelErrorOutput {
  if (error.code === "VALIDATION") {
    return {
      kind: "validation",
      safeText: `Invalid input: ${sanitizeValidationMessage(error.message)}`,
      rawMessage: error.message,
    };
  }
  if (error.code === "AUTH_REQUIRED") {
    return {
      kind: "auth-required",
      safeText: USER_MESSAGES.AUTH_REQUIRED,
      error,
    };
  }
  // Use Object.hasOwn to fall back safely on unrecognized codes (version
  // skew, deserialized remote errors). Indexing a Record with an unknown
  // string returns undefined at runtime, which would surface as empty
  // channel output otherwise.
  const text = Object.hasOwn(USER_MESSAGES, error.code)
    ? USER_MESSAGES[error.code]
    : UNKNOWN_CODE_MESSAGE;
  return { kind: "text", text };
}

/**
 * Convenience helper for adapters that have no special handling for
 * validation or auth-required cases — collapses the discriminated union
 * to a single string. Equivalent to using `safeText` for validation /
 * auth-required and `text` for everything else.
 *
 * Adapters that surface OAuth handoff or want stricter validator-text
 * escaping should call `formatErrorForChannel` directly instead.
 */
export function formatErrorTextForChannel(error: KoiError): string {
  const out = formatErrorForChannel(error);
  switch (out.kind) {
    case "text":
      return out.text;
    case "validation":
    case "auth-required":
      return out.safeText;
  }
}
