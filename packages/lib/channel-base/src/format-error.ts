/**
 * User-facing error formatting for channel adapters.
 *
 * Returns a discriminated union so adapters handle the three trust classes
 * explicitly:
 *
 *   - `kind: "text"` — canned, fully user-safe string. Concatenate into
 *     channel output as-is.
 *   - `kind: "validation"` — the validator's own message is user-relevant
 *     input feedback. The helper returns a pre-sanitized plain-text
 *     `safeText` only (formatting/mention/URL/control characters
 *     stripped or redacted, length-capped). The raw `error.message` is
 *     deliberately NOT exposed: adapters that route around the sanitizer
 *     would re-introduce the URL/phishing/mention surface this helper
 *     exists to close. Adapters that need richer validation UX should
 *     consume `KoiError.context` for structured field errors.
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
// Unicode bidi / formatting / zero-width controls that can hide or
// reorder text without being visible — defeats the plain-text claim
// without an explicit strip pass:
//   U+200B–U+200F  ZWSP, ZWNJ, ZWJ, LRM, RLM
//   U+202A–U+202E  bidi embeddings + override
//   U+2066–U+2069  isolate controls (LRI, RLI, FSI, PDI)
//   U+FEFF         byte order mark / zero-width no-break space
const UNICODE_CONTROL_CHARS = /[​-‏‪-‮⁦-⁩﻿]/g;
// Characters that drive formatting, mentions, links, or escaping on at
// least one common chat transport (Slack/Discord/Markdown/HTML/Teams).
// Stripping rather than escaping because we can't know the destination
// transport at this layer; the sanitizer's contract is "plain text".
const FORMATTING_CHARS = /[@`*_~#|!&\\[\]()<>{}]/g;
const URL_LIKE = /\b(?:https?|ftps?|wss?):\/\/\S+/gi;
const WWW_LIKE = /\bwww\.\S+/gi;

/**
 * Reduces a validator-controlled string to inert plain text:
 *   - replaces ASCII control chars with spaces;
 *   - redacts http/https/ws/ftp URLs and `www.` hostnames;
 *   - strips formatting/mention/escape characters that any common chat
 *     transport (Slack, Discord, Markdown, HTML, Teams) would interpret
 *     as a link, mention, code span, emphasis, header, table cell, image,
 *     entity, or escape;
 *   - caps the length.
 *
 * The output is "plain text" only. Adapters that render to a marked-up
 * transport must still apply transport-specific escaping (e.g. HTML-
 * encoding for HTML surfaces) on top of this pass.
 */
function sanitizeValidationMessage(raw: string): string {
  // NFC-normalize first so canonical-equivalent sequences (e.g. composed
  // vs decomposed accents) hit the strip passes consistently.
  const stripped = raw
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(UNICODE_CONTROL_CHARS, "")
    .replace(URL_LIKE, "link removed")
    .replace(WWW_LIKE, "link removed")
    .replace(FORMATTING_CHARS, "");
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
      /**
       * Plain-text rendering of the validator's message, with formatting,
       * mention, URL, and control characters stripped/redacted. Adapters
       * that render to marked-up transports (HTML, etc.) must still apply
       * their own transport-specific escaping on top.
       *
       * Adapters that need richer validation UX (structured field errors,
       * for example) should treat `KoiError.context` as their structured
       * input — this helper deliberately does not expose `error.message`
       * so adapters cannot accidentally route attacker-controlled text
       * around the URL/formatting redaction performed here.
       */
      readonly safeText: string;
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
