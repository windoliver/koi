/**
 * Error helpers for manifest resolution.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { levenshteinDistance } from "@koi/validation";
import type { ResolutionFailure } from "./types.js";

/** Maximum Levenshtein distance to consider a name a "close match". */
const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Finds the closest name from a list of candidates.
 * Returns undefined if no match is within MAX_SUGGESTION_DISTANCE.
 */
export function findClosestName(target: string, candidates: readonly string[]): string | undefined {
  return candidates.reduce<{ readonly distance: number; readonly match: string | undefined }>(
    (best, candidate) => {
      const distance = levenshteinDistance(target, candidate, MAX_SUGGESTION_DISTANCE);
      return distance < best.distance ? { distance, match: candidate } : best;
    },
    { distance: MAX_SUGGESTION_DISTANCE + 1, match: undefined },
  ).match;
}

/**
 * Aggregates multiple resolution failures into a single KoiError.
 */
export function aggregateErrors(failures: readonly ResolutionFailure[]): KoiError {
  const lines = failures.map((f) => {
    const loc = f.index !== undefined ? `[${f.index}]` : "";
    return `  ${f.section}${loc} "${f.name}": ${f.error.message}`;
  });

  return {
    code: "VALIDATION",
    message: `Manifest resolution failed with ${failures.length} error(s):\n${lines.join("\n")}`,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: {
      failures: failures.map((f) => ({
        section: f.section,
        index: f.index,
        name: f.name,
        code: f.error.code,
        message: f.error.message,
      })),
    },
  };
}

/**
 * Formats a resolution error for CLI stderr output.
 */
export function formatResolutionError(error: KoiError): string {
  return `Resolution error: ${error.message}\n`;
}
