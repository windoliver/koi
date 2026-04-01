/**
 * String scanning — detect and censor secrets in a string value.
 */

import { applyCensor } from "./censor.js";
import { EMPTY_MATCHES } from "./patterns/collect.js";
import type { Censor, RedactStringResult, SecretMatch, SecretPattern } from "./types.js";

/** Pre-allocated result for the no-match fast path. */
function identityResult(text: string): RedactStringResult {
  return { text, changed: false, matchCount: 0 };
}

/**
 * Resolve overlapping matches: keep the longer one. Ties: earlier start wins.
 * Input must be sorted by start ascending.
 */
function resolveOverlaps(sorted: readonly SecretMatch[]): readonly SecretMatch[] {
  if (sorted.length <= 1) return sorted;

  const first = sorted[0];
  if (first === undefined) return sorted;
  const resolved: SecretMatch[] = [first];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const prev = resolved[resolved.length - 1];
    if (current === undefined || prev === undefined) continue;

    if (current.start >= prev.end) {
      resolved.push(current);
      continue;
    }

    const prevLen = prev.end - prev.start;
    const currLen = current.end - current.start;
    if (currLen > prevLen) {
      resolved[resolved.length - 1] = current;
    }
  }

  return resolved;
}

/**
 * Scan a string for secrets using all patterns, resolve overlaps, apply censor.
 * Returns the censored string and match count.
 */
export function scanSecrets(
  text: string,
  patterns: readonly SecretPattern[],
  censor: Censor,
  maxStringLength: number,
): RedactStringResult {
  if (text.length === 0) return identityResult(text);
  if (text.length > maxStringLength) {
    return { text: "[REDACTED_OVERSIZED]", changed: true, matchCount: 1 };
  }

  // Collect matches from all detectors
  const allMatches: SecretMatch[] = [];
  for (const pattern of patterns) {
    const found = pattern.detect(text);
    if (found !== EMPTY_MATCHES) {
      for (const match of found) {
        allMatches.push(match);
      }
    }
  }

  if (allMatches.length === 0) return identityResult(text);

  // Sort by start ascending, then by length descending for stability
  allMatches.sort((a, b) => {
    const startDiff = a.start - b.start;
    if (startDiff !== 0) return startDiff;
    return b.end - b.start - (a.end - a.start);
  });

  const resolved = resolveOverlaps(allMatches);

  // Apply replacements in reverse order to preserve indices
  // let justified: accumulates the modified text through replacements
  let result = text;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const match = resolved[i];
    if (match === undefined) continue;
    const replacement = applyCensor(match, censor);
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }

  return { text: result, changed: true, matchCount: resolved.length };
}
