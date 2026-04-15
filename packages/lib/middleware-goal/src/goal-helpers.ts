/**
 * Pure helper functions for goal middleware — keyword extraction, matching,
 * completion detection, drift detection, and interval computation.
 *
 * These are stateless, side-effect-free functions extracted from goal.ts
 * to keep the middleware factory focused on lifecycle orchestration.
 */

import type { InboundMessage } from "@koi/core";

import type { GoalItem } from "./config.js";

// ---------------------------------------------------------------------------
// Text normalization & keyword extraction
// ---------------------------------------------------------------------------

/**
 * Normalize text for keyword extraction and matching.
 *
 * Splits identifier boundaries so that short acronyms participate in
 * matching when they appear as distinct segments:
 *
 * - camelCase boundary (lower→upper) becomes a space: `fixCiPipeline`
 *   → `fix ci pipeline`.
 * - Common separators `_`, `-`, `/` become spaces: `fix_ci_pipeline`,
 *   `fix-ci-pipeline`, `src/fix/ci/runner.ts` all tokenize their parts.
 * - `.` is preserved (stripped, not split) so dotted versions like
 *   `Release v1.2.3` keep `v123` as a distinguishing token instead of
 *   collapsing to a bare `release` keyword.
 *
 * Remaining punctuation is stripped, then lowercased.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-/]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .toLowerCase();
}

/**
 * Extract keywords from objective text for matching.
 *
 * All non-empty tokens are kept, including short acronyms and numerals.
 * Short tokens would previously be dropped when a long word was present
 * in the same objective, but that erases distinguishing segments of
 * compound objectives like "iOS support" or "CI/CD pipeline" — leaving
 * only "support"/"pipeline" as generic keywords that false-trigger on
 * unrelated completion text. Keeping every token raises the majority
 * threshold and preserves acronyms as distinguishing signals.
 *
 * Match-time strictness is handled in matchesToken (exact for <=2,
 * prefix+bounded-suffix for 3, substring for >=4) so short tokens
 * cannot silently match inside longer words.
 */
export function extractKeywords(objectives: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const obj of objectives) {
    for (const word of normalizeText(obj).split(/\s+/)) {
      if (word.length > 0) result.add(word);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Token matching
// ---------------------------------------------------------------------------

/** Tokenize normalized text into a set of words for token-based matching. */
export function tokenizeNormalized(normalized: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const t of normalized.split(/\s+/)) {
    if (t.length > 0) tokens.add(t);
  }
  return tokens;
}

/**
 * Check whether a keyword matches within a set of tokens.
 *
 * Three-tier rule balances inflection tolerance against false-positive
 * risk as keyword length shrinks:
 *
 * - len <= 2 (e.g. "ci", "ui", "7"): exact token equality — prevents
 *   "ci" matching inside "cinema".
 * - len === 3 (e.g. "fix", "add", "api"): exact OR token-prefix with a
 *   bounded inflection suffix (<=3 chars). "fix" satisfies "fixing"
 *   (+ing), "fixed" (+ed), "fixups" (+ups), but not "additional" (+7)
 *   or "addressing" (+7). This handles common inflection without
 *   letting short verb roots swallow unrelated long words.
 * - len >= 4 (e.g. "write", "trajectory"): substring within any token —
 *   handles inflections and camelCase identifiers like
 *   "recordedTrajectoryPath" that don't get split by normalization.
 */
const MAX_INFLECTION_SUFFIX = 3;
export function matchesToken(keyword: string, tokens: ReadonlySet<string>): boolean {
  if (keyword.length <= 2) {
    return tokens.has(keyword);
  }
  if (keyword.length === 3) {
    for (const t of tokens) {
      if (t === keyword) return true;
      if (t.startsWith(keyword) && t.length - keyword.length <= MAX_INFLECTION_SUFFIX) {
        return true;
      }
    }
    return false;
  }
  for (const t of tokens) {
    if (t.includes(keyword)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a markdown todo block from goal items. */
export function renderGoalBlock(items: readonly GoalItem[], header: string): string {
  const lines = [header, ""];
  for (const item of items) {
    const mark = item.completed ? "x" : " ";
    lines.push(`- [${mark}] ${item.text}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

const COMPLETION_SIGNALS = /\b(?:completed|done|finished|accomplished)\b|\[x\]|✓|✅/i;

/**
 * Detect which objectives were completed based on response text.
 *
 * Requires a completion signal AND a majority of the objective's keywords
 * (>= 50%, minimum 2 if the objective has 2+ keywords) to match. This
 * prevents false positives from single generic words like "write" or
 * "integration" appearing in unrelated completion text.
 *
 * When `keywordsPerItem` is provided (pre-computed at session start),
 * uses those instead of re-extracting keywords on every call.
 */
export function detectCompletions<T extends GoalItem>(
  responseText: string,
  items: readonly T[],
  keywordsPerItem?: ReadonlyMap<string, ReadonlySet<string>>,
): readonly T[] {
  if (!COMPLETION_SIGNALS.test(responseText)) {
    return items;
  }

  const textTokens = tokenizeNormalized(normalizeText(responseText));
  return items.map((item) => {
    if (item.completed) return item;
    const keywords = keywordsPerItem?.get(item.text) ?? extractKeywords([item.text]);
    if (keywords.size === 0) return item;

    // Word-boundary match: exact for short keywords, prefix for >=3-char keywords.
    const matchCount = [...keywords].filter((kw) => matchesToken(kw, textTokens)).length;
    // Require majority match: at least half the keywords, minimum 2 if available
    const threshold = keywords.size === 1 ? 1 : Math.max(2, Math.ceil(keywords.size / 2));
    if (matchCount >= threshold) {
      return { ...item, completed: true };
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Check if the agent is drifting from goals based on recent messages.
 *
 * Prefers keywords with >= 4 chars to avoid stop-word pollution —
 * short keywords like "the", "for", "and" match in virtually any English
 * text, causing drift detection to never trigger. Falls back to all
 * keywords when no distinctive (>= 4 char) keywords exist (e.g.,
 * objectives like "Fix CI" that only have short tokens).
 */
export function isDrifting(
  messages: readonly InboundMessage[],
  keywords: ReadonlySet<string>,
): boolean {
  if (keywords.size === 0) return false;
  // Prefer distinctive keywords (>= 4 chars), fall back to all keywords
  // when the objective only has short tokens (e.g., "Fix CI" → {"fix","ci"})
  const all = [...keywords];
  const distinctive = all.filter((kw) => kw.length >= MIN_USER_KEYWORD_LENGTH);
  const effectiveKeywords = distinctive.length > 0 ? distinctive : all;

  const recent = messages.slice(-3);
  const textTokens = tokenizeNormalized(
    normalizeText(
      recent
        .map((m) =>
          m.content
            .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
            .map((b) => b.text)
            .join(" "),
        )
        .join(" "),
    ),
  );

  // Drifting if no effective keyword matches in recent messages.
  return !effectiveKeywords.some((kw) => matchesToken(kw, textTokens));
}

/**
 * Minimum keyword length for user-message keyword matching.
 * Short keywords (1-3 chars) include stop words like "the", "for", "and"
 * that would false-positive on virtually any user message. Only keywords
 * with >= 4 chars are distinctive enough for reliable triggering.
 */
const MIN_USER_KEYWORD_LENGTH = 4;

/**
 * Minimum number of keywords that must match in a user message to trigger
 * force-injection. Requires at least 2 matches to prevent single generic
 * keyword matches (e.g., "write" alone) from triggering on unrelated text.
 */
const MIN_USER_KEYWORD_MATCHES = 2;

/**
 * Check if a user message contains goal keywords.
 * Used to force-inject goals when the user references goal-related topics.
 *
 * Only checks keywords with >= 4 chars (filtering stop words) and requires
 * at least 2 keyword matches to avoid false positives from single generic
 * words appearing in unrelated messages.
 */
export function userMessageContainsKeywords(
  messages: readonly InboundMessage[],
  keywords: ReadonlySet<string>,
): boolean {
  if (keywords.size === 0) return false;
  // Filter to distinctive keywords only (>= 4 chars avoids stop words)
  const distinctive = [...keywords].filter((kw) => kw.length >= MIN_USER_KEYWORD_LENGTH);
  if (distinctive.length < MIN_USER_KEYWORD_MATCHES) return false;

  // Check only the most recent user message (the current turn's input)
  const userMessages = messages.filter(
    (m) => m.senderId === "user" || m.senderId.startsWith("user:"),
  );
  const latest = userMessages.at(-1);
  if (!latest) return false;

  const text = latest.content
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join(" ");

  const textTokens = tokenizeNormalized(normalizeText(text));
  const matchCount = distinctive.filter((kw) => matchesToken(kw, textTokens)).length;
  return matchCount >= MIN_USER_KEYWORD_MATCHES;
}

// ---------------------------------------------------------------------------
// Interval computation
// ---------------------------------------------------------------------------

/** Compute next interval based on drift. With backoff removed, always returns baseInterval. */
export function computeNextInterval(
  _currentInterval: number,
  _drifting: boolean,
  baseInterval: number,
  _maxInterval: number,
): number {
  // Issue 2 fix: removed exponential backoff. Always use baseInterval.
  // Drift detection now runs every turn (Issue 1), so the interval only
  // controls injection cadence, not drift detection frequency.
  return baseInterval;
}
