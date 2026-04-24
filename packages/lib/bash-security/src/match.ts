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
/**
 * Decode a bash ANSI-C escape sequence body (what's inside `$'...'`).
 * Covers hex (`\xNN`), octal (`\NNN`), and the common letter escapes.
 */
function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[abefnrtv\\'"?])/g, (match, esc: string) => {
    if (esc.startsWith("x")) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    const letterMap: Record<string, string> = {
      a: "\x07",
      b: "\b",
      e: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    };
    return letterMap[esc] ?? match;
  });
}

export function normalizeForMatch(input: string): string {
  const nfkc = input.normalize("NFKC");
  // Shell quote removal + ANSI-C decoding so that bash-equivalent commands
  // normalize to the form the classifier patterns expect:
  //   - `$'r'$'m'` and `$'\x72\x6d'` decode to `rm`
  //   - `$"foo"` (locale-translated) strips to `foo`
  //   - `rm -r""f /etc` strips to `rm -rf /etc`
  //   - `"$HOME"/.ssh/x` strips to `$HOME/.ssh/x`
  // Concatenation of adjacent quoted segments (bash behavior) is implicit:
  // removing the delimiters and continuing the loop leaves neighboring
  // segments touching.
  let out = "";
  let i = 0;
  while (i < nfkc.length) {
    const ch = nfkc[i];
    // ANSI-C quoted: $'...' — decode escapes, drop delimiters.
    if (ch === "$" && nfkc[i + 1] === "'") {
      const end = findClosingQuote(nfkc, i + 2, "'");
      if (end !== -1) {
        out += decodeAnsiC(nfkc.slice(i + 2, end));
        i = end + 1;
        continue;
      }
    }
    // Locale-translated: $"..." — drop delimiters and `$`.
    if (ch === "$" && nfkc[i + 1] === '"') {
      const end = findClosingQuote(nfkc, i + 2, '"');
      if (end !== -1) {
        out += nfkc.slice(i + 2, end);
        i = end + 1;
        continue;
      }
    }
    // Ordinary quotes: strip unescaped `'` and `"`.
    if ((ch === '"' || ch === "'") && nfkc[i - 1] !== "\\") {
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Find the index of the next unescaped closing quote, respecting odd/even
 * backslash counts. Returns -1 if none found (malformed input).
 */
function findClosingQuote(s: string, from: number, quote: "'" | '"'): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
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
