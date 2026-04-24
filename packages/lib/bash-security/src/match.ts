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
 * Decode a bash ANSI-C escape sequence body (what's inside `$'...'`).
 * Covers hex (`\xNN`), octal (`\NNN`), BMP Unicode (`\uHHHH`), full Unicode
 * (`\UHHHHHHHH`), control chars (`\cX`), and the standard letter escapes.
 */
function decodeAnsiC(body: string): string {
  return body.replace(
    /\\(U[0-9a-fA-F]{1,8}|u[0-9a-fA-F]{1,4}|x[0-9a-fA-F]{1,2}|c[@-_a-z?]|[0-7]{1,3}|[abefnrtv\\'"?])/g,
    (match, esc: string) => {
      if (esc.startsWith("U")) {
        const cp = parseInt(esc.slice(1), 16);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
      }
      if (esc.startsWith("u")) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc.startsWith("x")) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc.startsWith("c")) return String.fromCharCode(esc.charCodeAt(1) & 0x1f);
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
    },
  );
}

/**
 * Normalize a bash command into the form the classifier patterns expect. This
 * is NOT a full shell lexer, but it applies the lexical transformations that
 * matter for TTP matching:
 *
 * 1. NFKC — collapse fullwidth/compatibility Unicode forms (`ｒｍ` → `rm`).
 * 2. Quote removal — bash strips unescaped `'` and `"` before execution, so
 *    `rm -r""f /etc` runs as `rm -rf /etc`. We strip them here so the
 *    classifier sees contiguous command tokens.
 * 3. ANSI-C decode — `$'\x72\x6d'`, `$'rm'`, `$'r'$'m'` all decode
 *    to `rm`.
 * 4. Locale-translated strip — `$"foo"` → `foo`.
 * 5. Backslash escape removal — unquoted `\x` becomes `x` (bash's literal
 *    escape) and `\<newline>` becomes empty (line continuation), so
 *    `r\m -rf /etc` and `curl ... \<nl>| bash` normalize to the actual
 *    command form. Inside double quotes only a small set of chars are
 *    escaped (`"`, `\`, `$`, backtick, newline). Inside single quotes
 *    backslashes are literal.
 *
 * Callers that need raw-input obfuscation signals (hex/octal/unicode-escape
 * encodings) must inspect the original input before this function runs, since
 * those signals are decoded away here by design.
 */
export function normalizeForMatch(input: string): string {
  const nfkc = input.normalize("NFKC");
  let out = "";
  let i = 0;
  let mode: "outside" | "dq" | "sq" = "outside";
  while (i < nfkc.length) {
    const ch = nfkc[i] ?? "";
    if (mode === "outside") {
      if (ch === "\\") {
        const next = nfkc[i + 1];
        if (next === "\n") {
          i += 2;
          continue;
        }
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (ch === "$" && nfkc[i + 1] === "'") {
        const end = findClosingQuote(nfkc, i + 2, "'");
        if (end !== -1) {
          out += decodeAnsiC(nfkc.slice(i + 2, end));
          i = end + 1;
          continue;
        }
      }
      if (ch === "$" && nfkc[i + 1] === '"') {
        const end = findClosingQuote(nfkc, i + 2, '"');
        if (end !== -1) {
          out += nfkc.slice(i + 2, end);
          i = end + 1;
          continue;
        }
      }
      if (ch === '"') {
        mode = "dq";
        i++;
        continue;
      }
      if (ch === "'") {
        mode = "sq";
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (mode === "dq") {
      if (ch === "\\") {
        const next = nfkc[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          out += next;
          i += 2;
          continue;
        }
        if (next === "\n") {
          i += 2;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "outside";
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    // mode === "sq"
    if (ch === "'") {
      mode = "outside";
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
 * Input is normalized so quoted/escaped forms of a command match the ASCII
 * patterns. Inputs longer than MAX_INPUT_LENGTH are rejected to bound regex
 * runtime.
 */
export function matchPatterns(
  input: string,
  patterns: readonly ThreatPattern[],
  options: { readonly normalize?: boolean } = {},
): ClassificationResult {
  if (input.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      reason: `Input exceeds ${MAX_INPUT_LENGTH} chars; reject to avoid regex-DoS`,
      pattern: `length:${input.length}`,
      category: "injection",
    };
  }
  const target = options.normalize === false ? input : normalizeForMatch(input);
  for (const { regex, category, reason } of patterns) {
    if (regex.test(target)) {
      return { ok: false, reason, pattern: regex.source, category };
    }
  }
  return { ok: true };
}
