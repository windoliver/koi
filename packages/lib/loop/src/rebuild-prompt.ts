/**
 * Default prompt rebuilder + sanitization helpers.
 *
 * Goals:
 *   1. Include ONLY the latest failure by default, not full history (bounded prompt growth).
 *   2. Strip ANSI escape sequences — a crashing verifier must not be able to
 *      smuggle terminal control codes back through the LLM prompt.
 *   3. Redact non-printable control characters (except newline and tab).
 *   4. Truncate details to a fixed byte budget.
 *
 * Custom rebuilders can opt into the full recent history via
 * RebuildPromptContext.recentFailures, which is already sanitized+truncated.
 */

import { LOOP_DEFAULTS, type RebuildPromptContext, type VerifierResult } from "./types.js";

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

// ANSI CSI sequences (color codes, cursor movement, etc.)
// Matches ESC[ ... <final byte> where final byte is @-~
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we are stripping control chars
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// Other ESC sequences (OSC, charset selection, etc.)
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
const ANSI_OTHER = /\x1B[PX^_][\s\S]*?\x1B\\|\x1B\][\s\S]*?(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g;
// Non-printable control characters except newline (0x0A) and tab (0x09).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
const OTHER_CONTROLS = /[\x00-\x08\x0B-\x1F\x7F]/g;

// ---------------------------------------------------------------------------
// Credential redaction
// ---------------------------------------------------------------------------
//
// Verifier output — bun test, pytest, application startup logs — can
// contain secrets that are unsafe to forward back into an LLM prompt on
// retry: database URLs with embedded credentials, API keys, bearer
// tokens, JWTs, etc. These are heuristic patterns, not a perfect
// credential scanner, but they catch the overwhelming majority of real
// leaks from test failure output. Callers that need stricter redaction
// should pre-process verifier results in a custom rebuildPrompt before
// the string reaches the model.

const REDACTED = "[REDACTED]";

/**
 * Patterns for well-known credential shapes. Each entry has a pattern
 * (applied with /g) and a kind tag that selects the replacement style.
 * Kinds:
 *   - "full"    — replace the whole match with [REDACTED]
 *   - "bearer"  — keep the "Bearer " prefix, redact the token
 *   - "url"     — keep the scheme + username, redact the password
 *   - "kv"      — keep the key name, redact the value
 *
 * Order matters only for overlapping matches: run the more specific
 * patterns first.
 */
type CredentialPattern =
  | { readonly pattern: RegExp; readonly kind: "full" }
  | { readonly pattern: RegExp; readonly kind: "bearer" }
  | { readonly pattern: RegExp; readonly kind: "url" }
  | { readonly pattern: RegExp; readonly kind: "kv" };

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // API keys: common provider prefixes followed by >= 16 url-safe chars.
  {
    pattern: /\b(?:sk|pk)-(?:proj|live|test)?-?[A-Za-z0-9_-]{16,}/g,
    kind: "full",
  },
  {
    pattern: /\b(?:sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9]{16,}/g,
    kind: "full",
  },
  // GitHub: classic / fine-grained / oauth / installation tokens
  { pattern: /\bgh[pous]_[A-Za-z0-9]{20,}/g, kind: "full" },
  // Slack
  { pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, kind: "full" },
  // JWT: three base64-url segments separated by dots
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}/g,
    kind: "full",
  },
  // Bearer tokens (HTTP Authorization header shape)
  { pattern: /\bBearer\s+[A-Za-z0-9+/=_.-]{20,}/g, kind: "bearer" },
  // Basic auth inside URLs: scheme://user:password@host
  // Redacts the password portion only so the URL structure survives.
  {
    pattern: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/@\s]+):([^@\s]+)(@)/g,
    kind: "url",
  },
  // Generic key=value / key: value assignments for common secret names.
  // Case-insensitive; matches until whitespace or end-of-line.
  {
    pattern:
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi,
    kind: "kv",
  },
];

/**
 * Apply credential-pattern redaction. Runs after sanitizeDetails (which
 * strips terminal control chars) and before truncation. Each pattern is
 * applied in sequence; bearer and url patterns keep a stable prefix so
 * the model can still tell what TYPE of credential was redacted without
 * seeing the value.
 */
export function redactCredentials(input: string): string {
  let out = input;
  for (const entry of CREDENTIAL_PATTERNS) {
    out = out.replace(entry.pattern, (_match, ...groups) => {
      switch (entry.kind) {
        case "url": {
          // groups are [scheme+user, password, @]
          const schemeUser = groups[0] as string;
          const at = groups[2] as string;
          return `${schemeUser}:${REDACTED}${at}`;
        }
        case "kv": {
          const key = groups[0] as string;
          return `${key}=${REDACTED}`;
        }
        case "bearer":
          return `Bearer ${REDACTED}`;
        case "full":
          return REDACTED;
      }
    });
  }
  return out;
}

/**
 * Strip ANSI escapes, redact control characters, and scrub common
 * credential patterns. Safe for embedding in LLM prompts.
 */
export function sanitizeDetails(raw: string): string {
  const stripped = raw.replace(ANSI_CSI, "").replace(ANSI_OTHER, "").replace(OTHER_CONTROLS, "?");
  return redactCredentials(stripped);
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending "...[truncated]"
 * if it was cut. UTF-8 safe — never splits a multi-byte character.
 */
export function truncateBytes(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  const suffix = "...[truncated]";
  const suffixBytes = encoder.encode(suffix).length;
  const keep = Math.max(0, maxBytes - suffixBytes);
  // Walk back to a code-point boundary — TextDecoder with fatal:false replaces
  // invalid bytes, but we want a clean cut, so find the last valid UTF-8 start byte.
  let end = keep;
  // Walk backward while the byte at `end` is a UTF-8 continuation byte
  // (0b10xxxxxx). Safe under noUncheckedIndexedAccess because we explicitly
  // compare against undefined before the bitwise test.
  while (end > 0) {
    const b = bytes[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.subarray(0, end)) + suffix;
}

/**
 * Apply both sanitize + truncate. Used to normalize VerifierResult.details
 * before it is handed to a prompt rebuilder.
 */
export function normalizeDetails(
  raw: string,
  maxBytes: number = LOOP_DEFAULTS.failureDetailsBytes,
): string {
  return truncateBytes(sanitizeDetails(raw), maxBytes);
}

/**
 * Normalize a VerifierResult so its details field is safe to embed.
 */
export function normalizeVerifierResult(
  result: VerifierResult,
  maxBytes: number = LOOP_DEFAULTS.failureDetailsBytes,
): VerifierResult {
  if (result.ok) {
    return result.details === undefined
      ? result
      : { ok: true, details: normalizeDetails(result.details, maxBytes) };
  }
  return {
    ok: false,
    reason: result.reason,
    details: normalizeDetails(result.details, maxBytes),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

// ---------------------------------------------------------------------------
// Default rebuilder
// ---------------------------------------------------------------------------

export function defaultRebuildPrompt(ctx: RebuildPromptContext): string {
  const { initialPrompt, iteration, latestFailure } = ctx;
  if (latestFailure.ok) {
    // Should not happen — runUntilPass only calls rebuildPrompt on failure.
    return initialPrompt;
  }
  const header = [
    `Previous attempt (iteration ${iteration - 1}) failed verification:`,
    `  reason: ${latestFailure.reason}`,
    ...(latestFailure.exitCode !== undefined ? [`  exit code: ${latestFailure.exitCode}`] : []),
  ].join("\n");
  return `${initialPrompt}\n\n---\n${header}\n\n${latestFailure.details}\n\nFix the failure and try again.`;
}
