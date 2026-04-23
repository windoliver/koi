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
 * Neutralize Unicode-width obfuscation AND shell quote-removal before pattern
 * matching.
 *
 * - NFKC: attackers use fullwidth-Latin (`ｒｍ`) or compatibility forms the
 *   shell still executes but literal regex `\brm\b` never matches.
 * - Quote stripping: bash removes unescaped `'` and `"` before executing, so
 *   `rm -r""f /etc` runs as `rm -rf /etc`. Removing all unescaped quote chars
 *   before matching catches these quote-splitting bypasses. Empty `""`/`''`
 *   (used purely to break up flag strings) likewise flatten to nothing.
 *
 * Null bytes and ANSI escapes are intentionally preserved — the injection and
 * path patterns use them as signals of attack. Backslash-escaped characters
 * (e.g. `ha\rd`) are NOT normalized; that is a known limitation of the regex
 * classifier and belongs to the AST-based path in @koi/bash-ast.
 */
export function normalizeForMatch(input: string): string {
  const nfkc = input.normalize("NFKC");
  // Strip unescaped quote chars. Dollar-quoted regions — bash ANSI-C quoting
  // `$'...'` and locale-translated `$"..."` — are preserved intact because
  // their delimiters carry semantic meaning that the injection patterns key
  // on (`$'\x72\x6d'` detection). Backslash-escaped quotes (`\"` / `\'`) are
  // also preserved by inspecting the preceding char.
  let out = "";
  let inDollarQuote: "'" | '"' | null = null;
  for (let i = 0; i < nfkc.length; i++) {
    const ch = nfkc[i] ?? "";
    if (inDollarQuote !== null) {
      out += ch;
      if (ch === inDollarQuote && nfkc[i - 1] !== "\\") inDollarQuote = null;
      continue;
    }
    if (ch === "$") {
      const next = nfkc[i + 1];
      if (next === "'" || next === '"') {
        out += ch;
        out += next;
        inDollarQuote = next;
        i++;
        continue;
      }
    }
    if ((ch === '"' || ch === "'") && nfkc[i - 1] !== "\\") continue;
    out += ch;
  }
  return out;
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
