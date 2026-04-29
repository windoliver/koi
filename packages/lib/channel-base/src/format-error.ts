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
// like `evil.com` or `attacker.io/path` even without a scheme. Policy is
// deny-by-default for host-shape tokens (a curated TLD allowlist is
// fundamentally incomplete — `.zip`, `.mov`, `.support`, and any new gTLD
// would slip through). Instead match the full host-shape span and decide
// in a callback:
//
//   - any host shape with a trailing path/query/fragment marker
//     (`/`, `:`, `?`, `#`) → URL-like, redact;
//   - 2 labels (`evil.com`, `evil.zip`, `attacker.support`) → redact,
//     unless the trailing label is a known safe code/data file
//     extension (so `package.json`, `tsconfig.json` survive);
//   - 3+ labels → preserve as a dotted identifier path
//     (`user.profile.email`, `config.http.timeout`), unless the last
//     label is itself TLD-shape (2-letter ccTLD, or a small set of
//     unmistakable gTLDs like `com`/`net`/`org`/`gov`) — those land in
//     `<sub>.<host>.<tld>` autolink territory.
const HOST_SHAPE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/:?#][^\s]*)?/gi;
const SAFE_TRAILING_FILE_EXT: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "txt",
  "csv",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sh",
  "py",
  "rb",
  "go",
  "rs",
  "lock",
  "log",
  "env",
  "xml",
  "svg",
]);
// Allowlist of identifier-tail words that commonly appear as the LAST
// label of a dotted field path in validation messages. Keeping this
// allowlist small (vs maintaining a full PSL/TLD dataset) is the
// pragmatic tradeoff: any unlisted last-label word is treated as a
// potential domain and redacted. Adapters that need full identifier
// fidelity should consume `KoiError.context` directly.
const SAFE_IDENTIFIER_TAILS: ReadonlySet<string> = new Set([
  // common field/property names
  "email",
  "name",
  "type",
  "value",
  "id",
  "key",
  "code",
  "status",
  "kind",
  "label",
  "title",
  "text",
  "body",
  "message",
  "data",
  "info",
  "details",
  "address",
  "phone",
  "country",
  "city",
  "state",
  "zip",
  "postal",
  "password",
  "username",
  "user",
  "token",
  "secret",
  "hash",
  "signature",
  "size",
  "count",
  "index",
  "length",
  "limit",
  "offset",
  "page",
  "total",
  "timeout",
  "delay",
  "duration",
  "interval",
  "timestamp",
  "date",
  "time",
  "config",
  "settings",
  "options",
  "metadata",
  "tags",
  "attrs",
  "props",
  "url",
  "uri",
  "path",
  "query",
  "params",
  "fields",
  "items",
  "results",
  "entries",
  "input",
  "output",
  "result",
  "request",
  "response",
  "payload",
  "headers",
  "cookies",
  "version",
  "format",
  "encoding",
  "schema",
  "model",
  "ref",
  "min",
  "max",
  "start",
  "end",
  "first",
  "last",
  "next",
  "prev",
  "active",
  "enabled",
  "visible",
  "public",
  "private",
  "required",
  "optional",
  "valid",
  "invalid",
  "error",
  "errors",
  "warnings",
]);
const redactBareDomain = (match: string): string => {
  const pathIdx = match.search(/[/:?#]/);
  const host = pathIdx === -1 ? match : match.slice(0, pathIdx);
  const hadPath = pathIdx !== -1;
  if (hadPath) return "link removed";
  const labels = host.toLowerCase().split(".");
  const last = labels[labels.length - 1] ?? "";
  if (labels.length === 2) {
    // 2-label hosts: redact unless trailing label is a known code/data
    // file extension (`package.json`, `tsconfig.json`).
    return SAFE_TRAILING_FILE_EXT.has(last) ? match : "link removed";
  }
  // 3+ labels: redact UNLESS the token clearly reads as an identifier
  // path. A token qualifies as an identifier when it either contains a
  // digit/underscore in any label (so `payload.items0.sku` survives), or
  // its last label is in the small `SAFE_IDENTIFIER_TAILS` allowlist
  // (`user.profile.email`, `config.http.timeout`). All other 3+ label
  // host shapes — including phishing-bait like `login.company.careers`
  // or `auth.example.travel` whose TLDs are genuine but uncurated — are
  // redacted. The allowlist is a deliberate KISS tradeoff vs bundling a
  // full public-suffix dataset.
  const hasDigitOrUnderscore = labels.some((l) => /[0-9_]/.test(l));
  const isIdentifierTail = SAFE_IDENTIFIER_TAILS.has(last);
  return hasDigitOrUnderscore || isIdentifierTail ? match : "link removed";
};

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
  // Order: strip formatting/escape characters BEFORE running URL and host
  // pattern matches, so dotted identifier paths broken up by brackets
  // (`payload.items[0].sku` → `payload.items0.sku`) remain a single
  // contiguous match for the dotted-identifier preservation rule.
  const stripped = raw
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(UNICODE_CONTROL_CHARS, "")
    .replace(FORMATTING_CHARS, "")
    .replace(URL_LIKE, "link removed")
    .replace(WWW_LIKE, "link removed")
    .replace(HOST_SHAPE, redactBareDomain);
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
    // OAuth scopes: alphanumeric plus `: / . - _ + = ? & # ~`.
    //
    // All-or-nothing display: if ANY non-empty token fails validation, or
    // if the joined result would exceed the length cap, omit `auth.scope`
    // entirely. Showing a partial scope list is a consent-UX hazard — the
    // user may approve an OAuth grant broader than what the channel
    // displayed. Adapters that need full granular display must consume
    // the original error.context themselves under their trust policy.
    const allowedToken = /^[A-Za-z0-9:/.\-_+=?&#~]+$/;
    // Distinguish four cases for tokens:
    //
    //   1. No colon (`read`, `email`): identifier — alphanumeric +
    //      `_` `-` only. Rejects junk like `???` even though
    //      `allowedToken` would accept it.
    //   2. URI shape (`scheme://host/...`): scheme MUST be in
    //      `URI_TOKEN_ALLOWED_SCHEMES` (https, api). Anything else
    //      (`zoommtg://`, `slack://`, etc.) is rejected — chat surfaces
    //      treat these as click-to-open-app handlers.
    //   3. URN form (`urn:ietf:params:oauth:...`): allowed as a literal
    //      `urn:...` opaque identifier.
    //   4. Scope-name shape (`chat:write`, `read:user`,
    //      `write:repo_hook`, `spotify:track:abc`): require strict
    //      `identifier(:identifier)+` shape — alphanumeric + `_`,
    //      first char alpha, NO URI-suffix characters (`/`, `?`,
    //      `#`, `&`, `=`, `+`, `.`, `~`, `-`). Additionally reject any
    //      prefix that names a known clickable URI scheme. This is
    //      deny-by-default for unknown scheme-shaped tokens — better
    //      to silently drop the whole `auth.scope` field than render
    //      an attacker-controlled `zoommtg:join` as a clickable
    //      handoff.
    const URI_TOKEN_ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["https", "api"]);
    const PLAIN_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;
    const SAFE_SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)+$/;
    // App- and OS-registered URI schemes that a chat surface can autolink
    // into a click-to-launch handoff. Even when wrapped in an
    // `identifier:identifier` shape (`zoommtg:join`, `spotify:track`),
    // these names register OS-level handlers — keep them out of consent
    // text rendered as scope.
    const APP_SCHEME_PREFIXES: ReadonlySet<string> = new Set([
      "http",
      "ftp",
      "ftps",
      "mailto",
      "javascript",
      "vbscript",
      "data",
      "file",
      "sms",
      "tel",
      "vscode",
      "slack",
      "app",
      "intent",
      "chrome",
      "zoommtg",
      "zoomus",
      "zoom",
      "msteams",
      "msoutlook",
      "skype",
      "spotify",
      "tg",
      "whatsapp",
      "discord",
      "steam",
      "fb",
      "instagram",
      "weixin",
      "weibo",
    ]);
    const isAllowedScopeToken = (t: string): boolean => {
      if (!allowedToken.test(t)) return false;
      const colonIdx = t.indexOf(":");
      if (colonIdx === -1) return PLAIN_IDENTIFIER.test(t);
      const scheme = t.slice(0, colonIdx).toLowerCase();
      // URI shape: scheme://host/...
      if (t.startsWith(`${scheme}://`)) return URI_TOKEN_ALLOWED_SCHEMES.has(scheme);
      // urn:... opaque identifier form
      if (scheme === "urn") return true;
      // Otherwise must be a strict scope-name (no URI-suffix chars) AND
      // its prefix must not name a known clickable URI scheme.
      if (!SAFE_SCOPE_NAME.test(t)) return false;
      return !APP_SCHEME_PREFIXES.has(scheme);
    };
    const normalized = scope
      .normalize("NFC")
      .replace(CONTROL_CHARS, " ")
      .replace(UNICODE_CONTROL_CHARS, "");
    const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);
    const allValid = tokens.length > 0 && tokens.every((t) => isAllowedScopeToken(t));
    if (allValid) {
      const joined = tokens.join(" ");
      // Reject (do not truncate) when the full scope cannot fit. A
      // truncated scope list misleads the consent UX in the same way
      // a partially-filtered list does.
      if (joined.length <= SCOPE_MAX_LEN) {
        out.scope = joined;
      }
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
