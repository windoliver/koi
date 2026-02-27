/**
 * Match application — reverse-index processing + longest-match-wins overlap resolution.
 */

import type { PIIHasherFactory } from "./strategies.js";
import { applyHash, applyMask, applyRedact } from "./strategies.js";
import type { PIIMatch, PIIStrategy } from "./types.js";

/** Result of applying PII replacements to a string. */
export interface ApplyResult {
  readonly text: string;
  readonly matches: readonly PIIMatch[];
}

/** Pre-allocated result for the no-match case. */
const IDENTITY_MATCHES: readonly PIIMatch[] = [];

/**
 * Resolve overlapping matches: keep the longer one. Ties: earlier start wins.
 * Input must be sorted by start ascending.
 */
function resolveOverlaps(sorted: readonly PIIMatch[]): readonly PIIMatch[] {
  const first = sorted[0];
  if (sorted.length <= 1 || first === undefined) return sorted;

  const resolved: PIIMatch[] = [first];
  // let justified: tracks tail of resolved to avoid re-indexing under noUncheckedIndexedAccess
  let last: PIIMatch = first;

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    if (current === undefined) continue; // noUncheckedIndexedAccess guard (i < sorted.length)

    // No overlap — keep both
    if (current.start >= last.end) {
      resolved.push(current);
      last = current;
      continue;
    }

    // Overlap — keep the longer match
    const prevLen = last.end - last.start;
    const currLen = current.end - current.start;
    if (currLen > prevLen) {
      resolved[resolved.length - 1] = current;
      last = current;
    }
    // else: keep last (earlier or equal length wins)
  }

  return resolved;
}

/**
 * Apply a PII strategy to all non-overlapping matches in a string.
 *
 * 1. Collect all matches from all detectors
 * 2. Sort by start ascending
 * 3. Resolve overlaps (longest wins)
 * 4. Apply replacements in reverse index order (right-to-left) to preserve indices
 */
export function applyMatches(
  text: string,
  allMatches: readonly PIIMatch[],
  strategy: PIIStrategy,
  createHasher?: PIIHasherFactory,
): ApplyResult {
  if (allMatches.length === 0) {
    return { text, matches: IDENTITY_MATCHES };
  }

  // Sort by start ascending, then by length descending for stability
  const sorted = [...allMatches].sort((a, b) => {
    const startDiff = a.start - b.start;
    if (startDiff !== 0) return startDiff;
    return b.end - b.start - (a.end - a.start);
  });

  const resolved = resolveOverlaps(sorted);

  // Apply in reverse order to preserve string indices
  // let justified: accumulates the modified text through replacements
  let result = text;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const match = resolved[i];
    if (match === undefined) continue; // noUncheckedIndexedAccess guard (i < resolved.length);
    // let justified: holds the replacement string for current match
    let replacement: string;

    switch (strategy) {
      case "redact":
        replacement = applyRedact(match);
        break;
      case "mask":
        replacement = applyMask(match);
        break;
      case "hash": {
        if (createHasher === undefined) {
          throw new Error("Hash strategy requires a hasher factory");
        }
        replacement = applyHash(match, createHasher);
        break;
      }
      case "block":
        // Block strategy is handled at the middleware level, not here
        replacement = applyRedact(match);
        break;
    }

    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }

  return { text: result, matches: resolved };
}
