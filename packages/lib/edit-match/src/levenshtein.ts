/**
 * Sliding-window fuzzy matching with Levenshtein distance.
 *
 * Uses a bounded similarity threshold (0.8 by default) with early
 * termination when current-best exceeds threshold. Single-row DP
 * for O(n) space.
 */

/** Default minimum similarity for a fuzzy match to be accepted. */
export const FUZZY_THRESHOLD = 0.8;

/**
 * Compute Levenshtein distance between two strings using a single-row DP.
 * Returns early if the distance exceeds `maxDistance` (for performance).
 */
export function computeLevenshtein(a: string, b: string, maxDistance: number): number {
  const m = a.length;
  const n = b.length;

  // Quick reject: if length difference alone exceeds max, bail early
  if (Math.abs(m - n) > maxDistance) {
    return maxDistance + 1;
  }

  // Use the shorter string for the DP row to minimize space
  const [short, long] = m <= n ? [a, b] : [b, a];
  const shortLen = short.length;
  const longLen = long.length;

  const row = new Array<number>(shortLen + 1);
  for (let i = 0; i <= shortLen; i++) {
    row[i] = i;
  }

  for (let j = 1; j <= longLen; j++) {
    // let justified: prev tracks the diagonal value from the previous row
    let prev = row[0] ?? 0;
    row[0] = j;
    let rowMin = j;

    for (let i = 1; i <= shortLen; i++) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      const current = Math.min(
        (row[i] ?? 0) + 1, // deletion
        (row[i - 1] ?? 0) + 1, // insertion
        prev + cost, // substitution
      );
      prev = row[i] ?? 0;
      row[i] = current;
      if (current < rowMin) {
        rowMin = current;
      }
    }

    // Early termination: if every cell in this row exceeds maxDistance,
    // no future row can produce a better result
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }

  return row[shortLen] ?? 0;
}

/** Result of a sliding window match. */
export interface SlidingWindowResult {
  /** Zero-based start index of the best-matching window in the source. */
  readonly startIndex: number;
  /** Zero-based end index (exclusive) of the best-matching window. */
  readonly endIndex: number;
  /** Similarity score from 0 to 1. */
  readonly similarity: number;
}

/**
 * Find the best fuzzy match of `search` within `source` using a sliding window.
 *
 * The window slides line-by-line (not character-by-character) for performance.
 * Returns undefined if no window meets the threshold.
 */
export function computeSlidingWindowMatch(
  source: string,
  search: string,
  threshold: number = FUZZY_THRESHOLD,
): SlidingWindowResult | undefined {
  const sourceLines = source.split("\n");
  const searchLines = search.split("\n");
  const searchLineCount = searchLines.length;

  if (searchLineCount === 0 || sourceLines.length === 0) {
    return undefined;
  }

  // Allow window sizes from searchLineCount-1 to searchLineCount+1
  // to tolerate minor line count differences
  const minWindowSize = Math.max(1, searchLineCount - 1);
  const maxWindowSize = Math.min(sourceLines.length, searchLineCount + 1);

  let best: SlidingWindowResult | undefined;
  let bestSimilarity = threshold;
  const maxDist = Math.ceil(search.length * (1 - threshold));

  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    for (let i = 0; i <= sourceLines.length - windowSize; i++) {
      const windowLines = sourceLines.slice(i, i + windowSize);
      const windowText = windowLines.join("\n");
      const dist = computeLevenshtein(windowText, search, maxDist);
      const maxLen = Math.max(windowText.length, search.length);

      if (maxLen === 0) {
        continue;
      }

      const similarity = 1 - dist / maxLen;
      if (similarity > bestSimilarity) {
        // Compute character offsets from line positions
        const startIndex = sourceLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
        const endText = sourceLines.slice(0, i + windowSize).join("\n");
        const _endIndex = endText.length + (i + windowSize > 0 && i === 0 ? 0 : 0);

        bestSimilarity = similarity;
        best = {
          startIndex,
          endIndex: startIndex + windowText.length,
          similarity,
        };
      }
    }
  }

  return best;
}
