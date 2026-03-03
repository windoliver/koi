/**
 * Match strategies — each tries a different approach to locate a search
 * block within source code. Ordered from most precise to most permissive.
 */

import { computeSlidingWindowMatch, FUZZY_THRESHOLD } from "./levenshtein.js";
import { normalizeIndentation, normalizeWhitespace } from "./normalize.js";
import type { MatchResult } from "./types.js";

/** Safe line access — returns "" for out-of-bounds indices (noUncheckedIndexedAccess). */
function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

/**
 * Strategy 1: Exact string match.
 * Confidence: 1.0. Requires byte-for-byte equality.
 */
export function matchExact(source: string, search: string): MatchResult | undefined {
  const idx = source.indexOf(search);
  if (idx === -1) {
    return undefined;
  }

  // Reject if there are multiple occurrences (ambiguous)
  const secondIdx = source.indexOf(search, idx + 1);
  if (secondIdx !== -1) {
    return undefined;
  }

  return {
    found: true,
    startIndex: idx,
    endIndex: idx + search.length,
    strategy: "exact",
    confidence: 1.0,
  };
}

/**
 * Strategy 2: Whitespace-normalized match.
 * Collapses all runs of whitespace to single spaces and compares.
 * Confidence: 0.95.
 */
export function matchWhitespaceNormalized(source: string, search: string): MatchResult | undefined {
  const normalizedSearch = normalizeWhitespace(search);
  if (normalizedSearch.length === 0) {
    return undefined;
  }

  // Split source into lines and try to find a contiguous set that matches
  const sourceLines = source.split("\n");
  const searchLines = search.split("\n").filter((l) => l.trim().length > 0);
  const searchLineCount = searchLines.length;

  if (searchLineCount === 0) {
    return undefined;
  }

  let matchCount = 0;
  let bestStart = -1;
  let bestEnd = -1;
  let found = false;

  for (let i = 0; i < sourceLines.length; i++) {
    if (matchCount === 0) {
      // Check if this line starts a match
      const normalizedSource = normalizeWhitespace(lineAt(sourceLines, i));
      const normalizedSearchLine = normalizeWhitespace(lineAt(searchLines, 0));
      if (normalizedSource === normalizedSearchLine) {
        bestStart = i;
        matchCount = 1;
      }
    } else {
      const normalizedSource = normalizeWhitespace(lineAt(sourceLines, i));
      // Skip empty source lines in the middle
      if (normalizedSource.length === 0) {
        continue;
      }
      const normalizedSearchLine = normalizeWhitespace(lineAt(searchLines, matchCount));
      if (normalizedSource === normalizedSearchLine) {
        matchCount++;
      } else {
        // Reset
        matchCount = 0;
        // Re-check current line as potential start
        const normalizedFirstSearch = normalizeWhitespace(lineAt(searchLines, 0));
        if (normalizedSource === normalizedFirstSearch) {
          bestStart = i;
          matchCount = 1;
        }
      }
    }

    if (matchCount === searchLineCount) {
      bestEnd = i;
      found = true;
      break;
    }
  }

  if (!found) {
    return undefined;
  }

  // Check for duplicate match (ambiguity)
  let secondMatchCount = 0;
  for (let i = bestEnd + 1; i < sourceLines.length; i++) {
    const normalizedSource = normalizeWhitespace(lineAt(sourceLines, i));
    if (normalizedSource.length === 0) {
      continue;
    }
    const normalizedSearchLine = normalizeWhitespace(lineAt(searchLines, secondMatchCount));
    if (normalizedSource === normalizedSearchLine) {
      secondMatchCount++;
      if (secondMatchCount === searchLineCount) {
        return undefined; // Ambiguous
      }
    } else {
      secondMatchCount = 0;
      const normalizedFirstSearch = normalizeWhitespace(lineAt(searchLines, 0));
      if (normalizedSource === normalizedFirstSearch) {
        secondMatchCount = 1;
      }
    }
  }

  const startIdx = sourceLines.slice(0, bestStart).join("\n").length + (bestStart > 0 ? 1 : 0);
  const matchText = sourceLines.slice(bestStart, bestEnd + 1).join("\n");

  return {
    found: true,
    startIndex: startIdx,
    endIndex: startIdx + matchText.length,
    strategy: "whitespace-normalized",
    confidence: 0.95,
  };
}

/**
 * Strategy 3: Indentation-flexible match.
 * Strips common leading whitespace from both search and source windows,
 * then compares. Handles copy-paste indentation mismatches.
 * Confidence: 0.9.
 */
export function matchIndentationFlexible(source: string, search: string): MatchResult | undefined {
  const normalizedSearch = normalizeIndentation(search).trim();
  if (normalizedSearch.length === 0) {
    return undefined;
  }

  const sourceLines = source.split("\n");
  const searchLineCount = search.split("\n").filter((l) => l.trim().length > 0).length;

  if (searchLineCount === 0) {
    return undefined;
  }

  let bestStart = -1;
  let bestEnd = -1;

  // Slide a window of searchLineCount lines
  for (let i = 0; i <= sourceLines.length - searchLineCount; i++) {
    const window = sourceLines.slice(i, i + searchLineCount);
    const normalizedWindow = normalizeIndentation(window.join("\n")).trim();
    if (normalizedWindow === normalizedSearch) {
      if (bestStart !== -1) {
        return undefined; // Ambiguous
      }
      bestStart = i;
      bestEnd = i + searchLineCount;
    }
  }

  if (bestStart === -1) {
    return undefined;
  }

  const startIdx = sourceLines.slice(0, bestStart).join("\n").length + (bestStart > 0 ? 1 : 0);
  const matchText = sourceLines.slice(bestStart, bestEnd).join("\n");

  return {
    found: true,
    startIndex: startIdx,
    endIndex: startIdx + matchText.length,
    strategy: "indentation-flexible",
    confidence: 0.9,
  };
}

/**
 * Strategy 4: Fuzzy match via sliding-window Levenshtein.
 * Uses 0.8 similarity threshold with early termination.
 * Confidence: the computed similarity score (0.8+).
 */
export function matchFuzzy(
  source: string,
  search: string,
  threshold: number = FUZZY_THRESHOLD,
): MatchResult | undefined {
  if (search.length === 0) {
    return undefined;
  }
  const result = computeSlidingWindowMatch(source, search, threshold);
  if (result === undefined) {
    return undefined;
  }

  return {
    found: true,
    startIndex: result.startIndex,
    endIndex: result.endIndex,
    strategy: "fuzzy",
    confidence: result.similarity,
  };
}
