/**
 * Error helpers for manifest resolution.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ResolutionFailure } from "./types.js";

/**
 * Computes the Levenshtein edit distance between two strings.
 * Uses classic DP with O(min(a,b)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const aLen = short.length;
  const bLen = long.length;

  // let: mutated during row-swap each iteration
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr = new Array<number>(aLen + 1);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = short[i - 1] === long[j - 1] ? 0 : 1;
      curr[i] = Math.min((prev[i] ?? 0) + 1, (curr[i - 1] ?? 0) + 1, (prev[i - 1] ?? 0) + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[aLen] ?? 0;
}

/** Maximum Levenshtein distance to consider a name a "close match". */
const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Finds the closest name from a list of candidates.
 * Returns undefined if no match is within MAX_SUGGESTION_DISTANCE.
 */
export function findClosestName(target: string, candidates: readonly string[]): string | undefined {
  return candidates.reduce<{ readonly distance: number; readonly match: string | undefined }>(
    (best, candidate) => {
      const distance = levenshteinDistance(target, candidate);
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
