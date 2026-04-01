/**
 * Unknown field detection with Levenshtein-based "did you mean?" suggestions.
 */

import { findClosestMatch } from "@koi/validation";
import type { ManifestWarning } from "./types.js";

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
      const suggestion = findClosestMatch(key, knownFields);
      return {
        path: key,
        message: `Unknown field "${key}" in manifest`,
        ...(suggestion !== undefined ? { suggestion } : {}),
      };
    });
}
