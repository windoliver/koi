import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Neutralize Unicode-width obfuscation before pattern matching.
 *
 * Attackers use fullwidth-Latin (`ｒｍ`) or other canonical-equivalent forms
 * that the shell still executes but literal regex `\brm\b` never matches.
 * NFKC collapses those compatibility forms to their ASCII equivalents.
 *
 * Null bytes and ANSI escapes are intentionally preserved — the injection
 * and path patterns use them as signals of attack.
 */
export function normalizeForMatch(input: string): string {
  return input.normalize("NFKC");
}

/**
 * Run an input string against a list of pre-compiled threat patterns.
 * Returns the first match found with full diagnostic context, or { ok: true }
 * if no patterns match.
 *
 * Patterns MUST be compiled at module load time (as `const` declarations),
 * never inside this function — RegExp construction is not free.
 *
 * Input is NFKC-normalized so fullwidth/compatibility forms (e.g., `ｒｍ`)
 * match the ASCII patterns.
 */
export function matchPatterns(
  input: string,
  patterns: readonly ThreatPattern[],
): ClassificationResult {
  const normalized = normalizeForMatch(input);
  for (const { regex, category, reason } of patterns) {
    if (regex.test(normalized)) {
      return { ok: false, reason, pattern: regex.source, category };
    }
  }
  return { ok: true };
}
