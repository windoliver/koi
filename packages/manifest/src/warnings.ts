/**
 * Unknown field detection with Levenshtein-based "did you mean?" suggestions.
 */

import { levenshteinDistance } from "@koi/validation";
import type { ManifestWarning } from "./types.js";

/** Maximum Levenshtein distance to consider a field name a "close match". */
const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Finds the closest known field name to the given unknown field.
 *
 * @returns The closest match if within `MAX_SUGGESTION_DISTANCE`, or `undefined`.
 */
function findClosestField(unknown: string, knownFields: readonly string[]): string | undefined {
  return knownFields.reduce<{ readonly distance: number; readonly match: string | undefined }>(
    (best, known) => {
      const distance = levenshteinDistance(unknown, known, MAX_SUGGESTION_DISTANCE);
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
