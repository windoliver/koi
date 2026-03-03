/**
 * Levenshtein edit-distance computation with optional early-exit optimization.
 *
 * Uses the classic dynamic programming approach with O(min(a,b)) space.
 * The optional `maxDistance` parameter allows callers to bail out early
 * when only "close enough" matches matter (e.g., typo suggestions).
 */

/**
 * Computes the Levenshtein edit distance between two strings.
 *
 * @param a - First string
 * @param b - Second string
 * @param maxDistance - Optional upper bound; if the true distance exceeds this,
 *   returns `maxDistance + 1` without completing the full computation.
 *   Defaults to `Infinity` (no early exit).
 * @returns The edit distance, or `maxDistance + 1` if the distance exceeds `maxDistance`.
 */
export function levenshteinDistance(a: string, b: string, maxDistance: number = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Early exit: if lengths differ by more than maxDistance, result is guaranteed to exceed it
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  // Ensure `short` is the shorter string for O(min(a,b)) space
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  const aLen = short.length;
  const bLen = long.length;

  // DP matrix rows -- let: mutated during row-swap each iteration
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr = new Array<number>(aLen + 1);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;

    // let: tracks whether any cell in this row is within maxDistance
    let rowMin = j;

    for (let i = 1; i <= aLen; i++) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[i] ?? 0) + 1, // deletion
        (curr[i - 1] ?? 0) + 1, // insertion
        (prev[i - 1] ?? 0) + cost, // substitution
      );
      curr[i] = value;

      if (value < rowMin) {
        rowMin = value;
      }
    }

    // Early exit: if every cell in this row exceeds maxDistance, no future row can improve
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    // Swap rows
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[aLen] ?? 0;
}

/**
 * Finds the closest string match from candidates using Levenshtein distance.
 *
 * @param target - The string to find a match for
 * @param candidates - The list of candidate strings to compare against
 * @param maxDistance - Maximum distance to consider (default: 3)
 * @returns The closest match within maxDistance, or undefined
 */
export function findClosestMatch(
  target: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  return candidates.reduce<{ readonly distance: number; readonly match: string | undefined }>(
    (best, candidate) => {
      const distance = levenshteinDistance(target, candidate, maxDistance);
      return distance < best.distance ? { distance, match: candidate } : best;
    },
    { distance: maxDistance + 1, match: undefined },
  ).match;
}
