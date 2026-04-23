import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Maximum command length accepted by the classifier.
 *
 * Real-world bash commands rarely exceed a few KB. Pathological inputs (100+ KB
 * of repeated keywords) force V8 regex backtracking into super-linear time even
 * with bounded greedy spans, so we reject the input outright rather than pin
 * the event loop.
 */
export const MAX_INPUT_LENGTH = 8192;

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
 * match the ASCII patterns. Inputs longer than MAX_INPUT_LENGTH are rejected
 * to bound regex runtime.
 */
export function matchPatterns(
  input: string,
  patterns: readonly ThreatPattern[],
): ClassificationResult {
  if (input.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      reason: `Input exceeds ${MAX_INPUT_LENGTH} chars; reject to avoid regex-DoS`,
      pattern: `length:${input.length}`,
      category: "injection",
    };
  }
  const normalized = normalizeForMatch(input);
  for (const { regex, category, reason } of patterns) {
    if (regex.test(normalized)) {
      return { ok: false, reason, pattern: regex.source, category };
    }
  }
  return { ok: true };
}
