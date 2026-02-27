/**
 * Cascading match — tries strategies in order from most precise to
 * most permissive, returning the first successful match.
 */

import {
  matchExact,
  matchFuzzy,
  matchIndentationFlexible,
  matchWhitespaceNormalized,
} from "./strategies.js";
import type { MatchResult } from "./types.js";

/**
 * Find a match for `search` in `source` using a cascade of strategies:
 * 1. Exact
 * 2. Whitespace-normalized
 * 3. Indentation-flexible
 * 4. Fuzzy (Levenshtein with 0.8 threshold)
 *
 * Returns the first successful match, or undefined if none found.
 * Rejects ambiguous matches (multiple occurrences) at each strategy level.
 */
export function findMatch(source: string, search: string): MatchResult | undefined {
  if (search.length === 0) {
    return undefined;
  }

  return (
    matchExact(source, search) ??
    matchWhitespaceNormalized(source, search) ??
    matchIndentationFlexible(source, search) ??
    matchFuzzy(source, search)
  );
}

/**
 * Apply an edit: find `search` in `source` and replace with `replacement`.
 * Returns the new content and match info, or undefined if no match.
 */
export function applyEdit(
  source: string,
  search: string,
  replacement: string,
): { readonly content: string; readonly match: MatchResult } | undefined {
  const match = findMatch(source, search);
  if (match === undefined) {
    return undefined;
  }

  const content = source.slice(0, match.startIndex) + replacement + source.slice(match.endIndex);

  return { content, match };
}
