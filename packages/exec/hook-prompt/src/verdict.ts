/**
 * Verdict parsing utilities — extract structured decisions from model output.
 */

import type { HookVerdict } from "@koi/core";

/** Parsed verdict from model output. */
export interface ParsedVerdict {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

/**
 * Thrown when model output cannot be parsed into a valid verdict.
 *
 * Distinct from an explicit `ok: false` rejection — allows the executor
 * to apply `failMode` (open vs closed) to dependency/format failures.
 */
export class VerdictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictParseError";
  }
}

// ---------------------------------------------------------------------------
// JSON extraction — tolerant of common LLM output wrappers
// ---------------------------------------------------------------------------

/** Matches ```json ... ``` or ``` ... ``` fenced blocks. */
const FENCED_JSON_RE = /```(?:json)?\s*\n?([\s\S]*?)```/;

/**
 * Extract the first balanced `{...}` JSON object from text.
 *
 * Counts braces to find the first complete top-level object, avoiding the
 * greedy regex pitfall where `/\{[\s\S]*\}/` captures from first `{` to
 * last `}` across multiple unrelated objects.
 */
/**
 * Extract all balanced `{...}` JSON objects from text.
 *
 * Returns them in order so the caller can try each as a verdict candidate.
 */
function extractAllJsonObjects(text: string): readonly string[] {
  const results: string[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let found = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = inString;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          results.push(text.slice(start, i + 1));
          searchFrom = i + 1;
          found = true;
          break;
        }
      }
    }

    if (!found) break;
  }

  return results;
}

/**
 * Extract JSON candidate strings from common LLM output wrappers.
 *
 * Returns all candidates in priority order:
 * 1. Raw text if it already looks like JSON
 * 2. Content from code fences (```json ... ```)
 * 3. All balanced `{...}` objects found in the text
 */
function extractJsonCandidates(text: string): readonly string[] {
  const candidates: string[] = [];

  // Case 1: raw text starts with JSON — try the whole text first, then
  // fall through to balanced extraction for multi-object outputs
  if (text.startsWith("{") || text.startsWith("[")) {
    candidates.push(text);
  }

  // Case 2: fenced JSON block — extract fenced content as a candidate
  const fenceMatch = FENCED_JSON_RE.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    candidates.push(fenceMatch[1].trim());
  }

  // Case 3: all balanced `{...}` objects — always scan for these so
  // multi-object outputs (e.g., preamble JSON + verdict JSON) are covered
  for (const obj of extractAllJsonObjects(text)) {
    if (!candidates.includes(obj)) {
      candidates.push(obj);
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Plain-text denial detection
// ---------------------------------------------------------------------------

/**
 * Phrases where "no" is part of a benign/approval expression.
 * Checked before denial keywords to avoid false-positive blocks on
 * responses like "No issues detected" or "No concerns".
 */
const APPROVAL_PHRASES_RE =
  /\bno\s+(issues?|concerns?|problems?|objections?|risks?|violations?)\b/i;

/**
 * Denial patterns as word-boundary regexes. Multi-word phrases use `\s+`
 * to handle whitespace variation. Single words use `\b` boundaries to
 * prevent substring false positives (e.g., "notion" matching "no").
 */
const DENY_PATTERNS: readonly RegExp[] = [
  // Standalone denial keywords
  /\bblock(ed)?\b/i,
  /\bdeny\b/i,
  /\bdenied\b/i,
  /\breject(ed)?\b/i,
  /\brefuse[ds]?\b/i,
  /\bforbidden\b/i,
  /\bprohibit(ed)?\b/i,
  /\bdisallow(ed)?\b/i,
  /\bunsafe\b/i,
  /\bdangerous\b/i,
  /\bharmful\b/i,
  /\brisky\b/i,
  // Negation + qualifier phrases
  /\bnot\s+allowed\b/i,
  /\bnot\s+ok\b/i,
  /\bnot\s+safe\b/i,
  /\bnot\s+acceptable\b/i,
  /\bnot\s+permitted?\b/i,
  /\bshould\s+not\b/i,
  /\bmust\s+not\b/i,
  // Negation + approval keyword compounds (negated approvals = denial)
  /\bcannot\s+proceed\b/i,
  /\bcannot\s+continue\b/i,
  /\bcan'?t\s+proceed\b/i,
  /\bcan'?t\s+continue\b/i,
  /\bcan'?t\s+allow\b/i,
  /\bdo\s+not\s+proceed\b/i,
  /\bdo\s+not\s+continue\b/i,
  /\bdo\s+not\s+allow\b/i,
  /\bdon'?t\s+proceed\b/i,
  /\bdon'?t\s+continue\b/i,
  /\bdon'?t\s+allow\b/i,
  /\bnever\s+proceed\b/i,
  /\bnever\s+continue\b/i,
  /\bnever\s+allow\b/i,
  // Bare "no" only at sentence/phrase start followed by comma/period/end
  /(?:^|[.!?]\s+)no(?:\s*[,.]|\s*$)/im,
] as const;

/** The bare-"no" pattern (last in DENY_PATTERNS) that APPROVAL_PHRASES_RE suppresses. */
const BARE_NO_PATTERN = DENY_PATTERNS[DENY_PATTERNS.length - 1];

/**
 * Check if plain text contains explicit denial language.
 *
 * Uses word-boundary regex matching. When the text contains a benign "no +
 * positive" phrase (e.g., "no issues"), only the bare-"no" pattern is
 * suppressed — all other denial patterns still fire. This prevents
 * "No issues detected, but do not proceed" from being misclassified.
 */
function containsDenialLanguage(text: string): boolean {
  const hasBenignNoPhrase = APPROVAL_PHRASES_RE.test(text);

  for (const pattern of DENY_PATTERNS) {
    // Skip bare-"no" pattern when a benign "no + positive" phrase is present
    if (hasBenignNoPhrase && pattern === BARE_NO_PATTERN) continue;
    if (pattern.test(text)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// ok field coercion
// ---------------------------------------------------------------------------

/**
 * Coerce the `ok` field to a boolean.
 *
 * Accepts real booleans directly. Coerces exact string booleans ("true"/"false")
 * to preserve the model's intent — a model saying `"ok": "false"` is clearly
 * trying to deny, and must not be routed through failMode as a parse error.
 *
 * Returns undefined for any other type (number, null, etc.) — caller should
 * throw VerdictParseError.
 */
function coerceOkField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Structured verdict parsing (returns undefined on any validation failure)
// ---------------------------------------------------------------------------

/** Result of attempting structured verdict parsing. */
type StructuredParseResult =
  | { readonly status: "ok"; readonly verdict: ParsedVerdict }
  | { readonly status: "not_json" }
  | { readonly status: "invalid_structure"; readonly detail: string };

/**
 * Attempt to parse a JSON string as a structured verdict.
 *
 * Returns a discriminated result so the caller can distinguish:
 * - "ok" — valid verdict, use it
 * - "not_json" — text wasn't parseable JSON, fall back to language detection
 * - "invalid_structure" — valid JSON but wrong shape/type, throw immediately
 *   (the model tried structured output but got the schema wrong)
 */
function tryParseStructuredVerdict(jsonText: string): StructuredParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { status: "not_json" };
  }

  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    return { status: "invalid_structure", detail: `Missing "ok" field: ${jsonText}` };
  }

  const obj = parsed as Record<string, unknown>;
  const ok = coerceOkField(obj.ok);
  if (ok === undefined) {
    return {
      status: "invalid_structure",
      detail: `"ok" must be a boolean, got ${typeof obj.ok}`,
    };
  }

  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  const verdict = reason !== undefined ? { ok, reason } : { ok };
  return { status: "ok", verdict };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse model output as a structured verdict.
 *
 * Tolerates common LLM wrappers (code fences, preamble text) by extracting
 * JSON before validation. Requires an `ok` field that is a boolean or exact
 * string boolean ("true"/"false"). Other types (numbers, null) throw.
 *
 * @throws {VerdictParseError} When no valid verdict JSON can be extracted
 */
export function parseVerdictOutput(raw: string): ParsedVerdict {
  const trimmed = raw.trim();

  if (trimmed === "") {
    throw new VerdictParseError("Empty model response");
  }

  // Try all JSON candidates in order — first valid verdict wins.
  const candidates = extractJsonCandidates(trimmed);
  let lastInvalidDetail: string | undefined;

  for (const candidate of candidates) {
    const result = tryParseStructuredVerdict(candidate);
    if (result.status === "ok") return result.verdict;

    if (result.status === "invalid_structure") {
      lastInvalidDetail = result.detail;
      // Continue searching — a later JSON object may be the real verdict
    }
    // "not_json" — continue searching
  }

  // If we found JSON with wrong structure and there's surrounding denial text,
  // honor the denial language.
  if (lastInvalidDetail !== undefined && candidates.length > 0) {
    if (candidates[0] !== trimmed && containsDenialLanguage(trimmed)) {
      return { ok: false, reason: trimmed };
    }
    // No more candidates and no denial language — the model tried structured
    // output but got the schema wrong. Throw so failMode can decide.
    throw new VerdictParseError(`Invalid verdict: ${lastInvalidDetail}`);
  }

  // No valid structured verdict — check for denial language in the full raw
  // text. Plain-text denials are always honored (fail-safe). Plain-text
  // approvals are NOT accepted — approvals require structured JSON to prevent
  // qualified approvals ("proceed only after backup") from being silently
  // upgraded to unconditional allows. Ambiguous text throws VerdictParseError
  // so failMode can decide.
  if (containsDenialLanguage(trimmed)) {
    return { ok: false, reason: trimmed };
  }

  throw new VerdictParseError(`No valid verdict in model output: ${trimmed}`);
}

/**
 * Map a parsed verdict to a HookVerdict discriminated union.
 */
export function mapVerdictToDecision(verdict: ParsedVerdict): HookVerdict {
  if (verdict.ok) {
    return { kind: "continue" };
  }
  return { kind: "block", reason: verdict.reason ?? "Blocked by prompt hook" };
}
