/**
 * Unknown field detection with Levenshtein-based "did you mean?" suggestions.
 */

import type { ManifestWarning } from "./types.js";

/** Maximum Levenshtein distance to consider a field name a "close match". */
const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Computes the Levenshtein edit distance between two strings.
 *
 * Uses the classic dynamic programming approach with O(min(a,b)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `short` is the shorter string for O(min(a,b)) space
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  const aLen = short.length;
  const bLen = long.length;

  // DP matrix rows — let: mutated during row-swap each iteration
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr = new Array<number>(aLen + 1);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        (prev[i] ?? 0) + 1, // deletion
        (curr[i - 1] ?? 0) + 1, // insertion
        (prev[i - 1] ?? 0) + cost, // substitution
      );
    }
    // Swap rows
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[aLen] ?? 0;
}

/**
 * Finds the closest known field name to the given unknown field.
 *
 * @returns The closest match if within `MAX_SUGGESTION_DISTANCE`, or `undefined`.
 */
function findClosestField(unknown: string, knownFields: readonly string[]): string | undefined {
  return knownFields.reduce<{ readonly distance: number; readonly match: string | undefined }>(
    (best, known) => {
      const distance = levenshteinDistance(unknown, known);
      return distance < best.distance ? { distance, match: known } : best;
    },
    { distance: MAX_SUGGESTION_DISTANCE + 1, match: undefined },
  ).match;
}

/**
 * Detects unknown top-level fields in parsed YAML and produces warnings.
 *
 * @param parsed - The parsed YAML object
 * @param knownFields - List of known/valid field names
 * @returns Array of warnings for unknown fields
 */
export function detectUnknownFields(
  parsed: Readonly<Record<string, unknown>>,
  knownFields: readonly string[],
): readonly ManifestWarning[] {
  const knownSet = new Set(knownFields);

  return Object.keys(parsed)
    .filter((key) => !knownSet.has(key))
    .map((key): ManifestWarning => {
      const suggestion = findClosestField(key, knownFields);
      return {
        path: key,
        message: `Unknown field "${key}" in manifest`,
        ...(suggestion !== undefined ? { suggestion } : {}),
      };
    });
}
