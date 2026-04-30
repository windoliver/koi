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
//
// `_` is split out — it's a Markdown emphasis sigil at word boundaries
// (`_under_`) but a code identifier separator inside words
// (`email_address`). The boundary-aware strip below handles both.
const FORMATTING_CHARS = /[@`*~#|!&\\[\]()<>{}]/g;
// Strip runs of `_` that are NOT bounded on both sides by alphanumerics —
// that excludes `email_address`-style identifiers but catches Markdown
// emphasis `_under_`, leading/trailing `__`, etc.
const BOUNDARY_UNDERSCORES = /(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g;
// Match ANY scheme-form URI, not just http/ftp/ws. Many chat transports
// (Slack, Discord, Teams, Gmail, VS Code) autolink or trigger client
// actions on schemes like mailto:, file:, slack:, vscode:, sms:, tel:,
// data:, javascript:, app://. Default to deny: strip any token of the
// shape `<scheme>:<rest>` where scheme is a valid RFC 3986 scheme name.
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:[^\s]+/gi;
const WWW_LIKE = /\bwww\.\S+/gi;
// IDN / Unicode bare-host trap: chat clients auto-link Internationalized
// Domain Names (e.g. `例子.测试`) and mixed-script Punycode-bait
// (`gооgle.com` with Cyrillic `о`). HOST_SHAPE (below) is ASCII-only by
// design — a separate pass must catch any whitespace-bounded token that
// contains both a `.` and at least one non-ASCII character.
//
// Pattern: a token (run of non-whitespace) that contains a `.` AND a
// non-ASCII byte (>= U+0080). The negative-class anchor falls outside
// printable ASCII (excluding the basic Latin set used for legitimate
// identifier paths).
// biome-ignore lint/suspicious/noControlCharactersInRegex: anchor for non-ASCII detection
const UNICODE_HOST_LIKE = /(?=\S*[.])\S*[^\x00-\x7f\s]\S*/gu;
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
// HOST_SHAPE includes `_` in label characters even though it's invalid
// in a real DNS hostname — that way snake_case identifier paths
// (`users0.email_address`) match as a single contiguous token, and the
// presence of `_` later signals "this is an identifier, not a hostname".
const HOST_SHAPE =
  /\b[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+(?:[/:?#][^\s]*)?/gi;
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
const redactBareDomain = (match: string): string => {
  const pathIdx = match.search(/[/:?#]/);
  const host = pathIdx === -1 ? match : match.slice(0, pathIdx);
  const hadPath = pathIdx !== -1;
  if (hadPath) return "link removed";
  const labels = host.toLowerCase().split(".");
  const last = labels[labels.length - 1] ?? "";
  // Identifier marker: underscore is the only TLD- and DNS-immune signal
  // ("_" is forbidden in DNS hostname labels by RFC 1035, so any token
  // with an underscore cannot be a real hostname). Digits and hyphens
  // are NOT enough — `evil-1.com`, `cdn1.example.org`, `my-store.com`
  // are all real domain shapes.
  const hasUnderscoreMarker = labels.some((l) => l.includes("_"));
  // 2-label hosts: preserve `package.json`-shape tokens via the file-
  // extension safelist, OR identifier-marker tokens
  // (`users0.email_address` after `[]` strip). Otherwise redact — the
  // corpus of 2-label attacker registrations (`evil.com`, `evil.zip`,
  // `evil.support`, …) is unbounded.
  if (labels.length === 2) {
    if (SAFE_TRAILING_FILE_EXT.has(last)) return match;
    return hasUnderscoreMarker ? match : "link removed";
  }
  // 3+ labels: redact UNLESS the token carries an underscore. Pure
  // all-lowercase-alpha 3+ label tokens (`user.profile.email`,
  // `login.attacker.email`, `auth.example.travel`) are indistinguishable
  // from real `<sub>.<host>.<tld>` domain shapes — modern ICANN gTLDs
  // include `email`, `name`, `info`, `zip`, `careers`, `travel`,
  // `health`, `phone`, `city`, `page`, `date`, etc. Tokens with digits
  // are also ambiguous (`cdn1.example.com`, `host-2.svc.local`).
  // Adapters that need richer dotted-field-path UX should consume
  // `KoiError.context` directly under their trust policy.
  return hasUnderscoreMarker ? match : "link removed";
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
  // Order: strip non-underscore formatting/escape characters BEFORE
  // running URL and host pattern matches, so dotted identifier paths
  // broken up by brackets (`payload.items[0].sku` → `payload.items0.sku`)
  // remain a single contiguous match. Underscores are kept through the
  // host pass (the sanitizer uses them as the identifier marker) and
  // stripped LAST, only when they're at word boundaries (Markdown
  // emphasis `_under_`) — `email_address`-style identifiers survive.
  const stripped = raw
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(UNICODE_CONTROL_CHARS, "")
    .replace(FORMATTING_CHARS, "")
    .replace(URL_LIKE, "link removed")
    .replace(WWW_LIKE, "link removed")
    .replace(UNICODE_HOST_LIKE, "link removed")
    .replace(HOST_SHAPE, redactBareDomain)
    .replace(BOUNDARY_UNDERSCORES, "");
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
    // Allow-by-default for tokens with strict, recognizable shapes; deny
    // everything else. The four accepted shapes:
    //
    //   1. Plain identifier (no colon, alphanumeric + `_`/`-`):
    //      `read`, `email`, `public_repo`.
    //   2. Full URI of an allowed scheme: `https://...` or `api://...`.
    //   3. URN: any `urn:...` opaque identifier.
    //   4. Scope-name shape (`identifier(:identifier)+`) — but ONLY when
    //      the leading prefix is in `KNOWN_SCOPE_NAMESPACES`. This is an
    //      explicit allowlist of OAuth scope namespaces published by
    //      mainstream providers (Slack, GitHub, Google, Microsoft,
    //      Discord). Any other `identifier:identifier` token is rejected,
    //      including unknown app-launch shapes like `raycast:open`,
    //      `figma:open`, `obsidian:open`, `zoommtg:join`,
    //      `spotify:track:abc` — many chat/desktop surfaces autolink
    //      these as click-to-launch handoffs.
    //
    // Prefer dropping the whole `auth.scope` field over rendering an
    // attacker-controlled clickable. Adapters that need richer scope
    // display must consume `error.context` themselves under their trust
    // policy.
    const URI_TOKEN_ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["https", "api"]);
    const PLAIN_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;
    const SAFE_SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)+$/;
    // Microsoft Graph and similar issuers use dotted PascalCase scope
    // names (`User.Read`, `Mail.Send`, `Files.Read.All`,
    // `Calendars.ReadWrite`). Accept tokens that match an
    // `Identifier(.Identifier)+` shape AND whose leading namespace is
    // on the allowlist.
    const DOTTED_SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
    // Known OAuth scope-name prefixes. Lowercase — matched
    // case-insensitively against the leading namespace before the
    // first colon. Maintained as a small explicit set instead of a
    // denylist of known-bad app schemes (which is perpetually
    // incomplete and reviewers correctly call out).
    const KNOWN_SCOPE_NAMESPACES: ReadonlySet<string> = new Set([
      // Slack
      "chat",
      "channels",
      "groups",
      "im",
      "mpim",
      "files",
      "users",
      "search",
      "stars",
      "emoji",
      "reactions",
      "pins",
      "reminders",
      "dnd",
      "team",
      "conversations",
      "bookmarks",
      "calls",
      "commands",
      "dialog",
      "links",
      // GitHub
      "read",
      "write",
      "admin",
      "repo",
      "gist",
      "notifications",
      "user",
      "public_repo",
      "delete_repo",
      "workflow",
      "packages",
      "security_events",
      // Google common
      "openid",
      "profile",
      "email",
      // Generic verbs (broad CRUD scopes some issuers use)
      "create",
      "update",
      "delete",
      "manage",
      "view",
      "list",
      // Microsoft Graph delegated permission shapes
      "mail",
      "calendars",
      "contacts",
      "directory",
      "group",
      "people",
      "tasks",
      "presence",
    ]);
    const isAllowedScopeToken = (t: string): boolean => {
      if (!allowedToken.test(t)) return false;
      const colonIdx = t.indexOf(":");
      if (colonIdx === -1) {
        if (PLAIN_IDENTIFIER.test(t)) return true;
        // Dotted PascalCase scopes (Microsoft Graph: `User.Read`,
        // `Files.Read.All`). Leading namespace must be allowlisted.
        if (DOTTED_SCOPE_NAME.test(t)) {
          const prefix = t.slice(0, t.indexOf(".")).toLowerCase();
          return KNOWN_SCOPE_NAMESPACES.has(prefix);
        }
        return false;
      }
      const scheme = t.slice(0, colonIdx).toLowerCase();
      // URI shape: scheme://host/...
      if (t.startsWith(`${scheme}://`)) return URI_TOKEN_ALLOWED_SCHEMES.has(scheme);
      // urn:... opaque identifier form
      if (scheme === "urn") return true;
      // Otherwise must be a strict scope-name shape AND its leading
      // namespace must be on the explicit allowlist.
      if (!SAFE_SCOPE_NAME.test(t)) return false;
      return KNOWN_SCOPE_NAMESPACES.has(scheme);
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
