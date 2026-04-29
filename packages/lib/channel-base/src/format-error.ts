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
// Match ANY scheme-form URI, not just http/ftp/ws. Many chat transports
// (Slack, Discord, Teams, Gmail, VS Code) autolink or trigger client
// actions on schemes like mailto:, file:, slack:, vscode:, sms:, tel:,
// data:, javascript:, app://. Default to deny: strip any token of the
// shape `<scheme>:<rest>` where scheme is a valid RFC 3986 scheme name.
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:[^\s]+/gi;
const WWW_LIKE = /\bwww\.\S+/gi;
// Bare-domain autolink trap: Slack/Discord/Teams/Gmail auto-link strings
// like `evil.example/path` or `login.company.com` even without a scheme.
// Match `<label>(.<label>)+` ending in a TLD-shaped suffix (2–24 letters)
// optionally followed by `/path`, `?query`, `:port`, etc. We accept some
// false positives (e.g. file names containing a 2-letter "TLD") because
// the contract is plain-text safety, not preserving sentence flow.
const BARE_DOMAIN_LIKE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:[/:?#][^\s]*)?/gi;

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
    .replace(BARE_DOMAIN_LIKE, "link removed")
    .replace(FORMATTING_CHARS, "");
  return stripped.length > VALIDATION_MAX_LEN
    ? `${stripped.slice(0, VALIDATION_MAX_LEN)}…`
    : stripped;
}

/**
 * Extracts the candidate-safe auth handoff fields from a KoiError context.
 * Returns only `authorizationUrl` and `scope` when present as strings, so
 * the discriminated `auth-required` payload can never accidentally leak
 * other context fields (user IDs, internal tokens, etc.) into adapter UX.
 */
// Cap on auth scope length: long enough for realistic OAuth scope strings
// (space-separated lists of resource identifiers), short enough that a
// hostile producer cannot dump arbitrary attacker text into adapter UX.
const SCOPE_MAX_LEN = 200;
// Cap on auth URL length. Real OAuth issuer authorize URLs are well under
// 2KB; anything longer is almost certainly an attacker payload smuggled
// through the auth handoff (overflowing logs, breaking renderers, etc.).
const AUTH_URL_MAX_LEN = 2_048;

/**
 * Normalizes an authorization URL into a render-safe candidate. Returns
 * `undefined` when the input is malformed, oversized, or uses a scheme
 * that does not belong in a clickable auth prompt (only http/https are
 * accepted — ftp/file/javascript:/data: are not). The result still
 * carries the `unverified` prefix because channel-base cannot validate
 * the host against tenant trust policy; adapters MUST run their own
 * allowlist check before rendering.
 */
function normalizeAuthUrl(raw: string): string | undefined {
  // Strip control/bidi chars and bound the size before parsing — keeps
  // bidi tricks and oversized payloads out of the URL constructor and
  // out of any logs that might capture this value.
  const cleaned = raw.replace(CONTROL_CHARS, "").replace(UNICODE_CONTROL_CHARS, "").trim();
  if (cleaned.length === 0 || cleaned.length > AUTH_URL_MAX_LEN) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return undefined;
  }
  // Only https — reject http (cleartext OAuth handoff is a credential
  // exposure risk), as well as ftp/javascript/data/file/etc.
  if (parsed.protocol !== "https:") return undefined;
  // Reject URLs with embedded userinfo. `https://user:pass@host/...`
  // can leak credentials when logged or rendered, and
  // `https://trusted.example@attacker.test/...` is a classic phishing
  // pattern where a naive host-prefix check matches the userinfo
  // instead of the actual host.
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  // URL.toString() canonicalizes (lowercases host, normalizes percent-
  // encoding) — that's what we want adapters to see and validate.
  return parsed.toString();
}

function extractAuthHandoff(error: KoiError): {
  readonly unverifiedAuthorizationUrl?: string;
  readonly scope?: string;
} {
  const ctx = error.context;
  if (ctx === undefined || ctx === null || typeof ctx !== "object") return {};
  const out: { unverifiedAuthorizationUrl?: string; scope?: string } = {};
  const url = (ctx as Record<string, unknown>).authorizationUrl;
  if (typeof url === "string") {
    const normalized = normalizeAuthUrl(url);
    if (normalized !== undefined) out.unverifiedAuthorizationUrl = normalized;
  }
  const scope = (ctx as Record<string, unknown>).scope;
  if (typeof scope === "string") {
    // OAuth scopes are space-separated tokens. Each token may be a
    // simple word (`read`, `email`) or a URI-shaped identifier
    // (`https://www.googleapis.com/auth/drive`, `api://resource/.default`).
    // We tokenize and admit ONLY tokens whose chars are valid in real
    // OAuth scopes: alphanumeric plus `: / . - _ + = ? & # ~`. This
    // preserves legitimate URI scopes while rejecting tokens that carry
    // chat-formatting payloads (`@everyone`, backticks, mentions,
    // markdown sigils, etc.) — the trust-boundary protection adapters
    // rely on when rendering this into an OAuth consent prompt.
    const allowedToken = /^[A-Za-z0-9:/.\-_+=?&#~]+$/;
    const tokens = scope
      .normalize("NFC")
      .replace(CONTROL_CHARS, " ")
      .replace(UNICODE_CONTROL_CHARS, "")
      .split(/\s+/)
      .filter((t) => t.length > 0 && allowedToken.test(t));
    const sanitized = tokens.join(" ");
    if (sanitized.length > 0) {
      out.scope =
        sanitized.length > SCOPE_MAX_LEN ? `${sanitized.slice(0, SCOPE_MAX_LEN)}…` : sanitized;
    }
  }
  return out;
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
      /**
       * Narrowed handoff payload. Only fields the channel-base layer
       * deems candidate-safe are exposed; the original `error.message`,
       * `error.cause`, and `error.context` (other than the documented
       * fields below) are deliberately withheld.
       *
       * The `unverified*` prefix on the URL is not cosmetic: the
       * channel-base layer cannot validate the URL against the adapter's
       * tenant/issuer trust policy. Treat it as attacker-controlled
       * input until the adapter runs it through an allowlist or other
       * trust check. Rendering it as a clickable link without that
       * check is a phishing footgun.
       */
      readonly auth: {
        readonly unverifiedAuthorizationUrl?: string;
        readonly scope?: string;
      };
    };

/**
 * Classifies a KoiError into a discriminated channel output. See module
 * docstring for the three discriminants and the trust contract on each.
 *
 * Adapters that need to surface OAuth handoff metadata (`auth-required`)
 * or apply transport-specific escaping on top of the validation sanitizer
 * (`validation.safeText`) should call this. Adapters that just want a
 * single safe string should call `formatErrorForChannel` instead.
 */
export function classifyErrorForChannel(error: KoiError): ChannelErrorOutput {
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
      auth: extractAuthHandoff(error),
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
 * Returns a single safe string for direct channel output. Collapses
 * `classifyErrorForChannel` to its safe-text form: `safeText` for
 * validation / auth-required, the canned `text` for everything else.
 *
 * This is the primary helper most adapters should call. The string return
 * type means it concatenates safely into channel payloads without any
 * conversion.
 */
export function formatErrorForChannel(error: KoiError): string {
  const out = classifyErrorForChannel(error);
  switch (out.kind) {
    case "text":
      return out.text;
    case "validation":
    case "auth-required":
      return out.safeText;
  }
}
