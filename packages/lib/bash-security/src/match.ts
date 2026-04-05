import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Run an input string against a list of pre-compiled threat patterns.
 * Returns the first match found with full diagnostic context, or { ok: true }
 * if no patterns match.
 *
 * Patterns MUST be compiled at module load time (as `const` declarations),
 * never inside this function — RegExp construction is not free.
 */
export function matchPatterns(
  input: string,
  patterns: readonly ThreatPattern[],
): ClassificationResult {
  for (const { regex, category, reason } of patterns) {
    if (regex.test(input)) {
      return { ok: false, reason, pattern: regex.source, category };
    }
  }
  return { ok: true };
}
