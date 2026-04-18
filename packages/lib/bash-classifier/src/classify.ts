/**
 * `classifyCommand(cmdLine)` — structural classification entry point.
 *
 * Pipeline:
 *   1. Tokenize on whitespace.
 *   2. Compute canonical permission prefix via `ARITY` table.
 *   3. Test every `DANGEROUS_PATTERNS` entry against the raw string.
 *   4. Aggregate worst severity.
 *
 * Pure function. No I/O. No side effects.
 */

import { DANGEROUS_PATTERNS } from "./patterns.js";
import { prefix, shellTokenize } from "./prefix.js";
import type { ClassifyResult, DangerousPattern, Severity } from "./types.js";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function worstSeverity(patterns: readonly DangerousPattern[]): Severity | null {
  if (patterns.length === 0) return null;
  let worst: Severity = patterns[0]?.severity ?? "low";
  for (const p of patterns) {
    if (SEVERITY_ORDER[p.severity] > SEVERITY_ORDER[worst]) {
      worst = p.severity;
    }
  }
  return worst;
}

function tokenize(cmdLine: string): readonly string[] {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) return [];
  // Shell-aware: preserves `FOO='x y'` as a single token, collapses
  // adjacent-quote obfuscation (`py''thon`) into `python`. Naive
  // whitespace split fragments these forms and produces a wrong
  // `prefix` for the exported ClassifyResult.
  return shellTokenize(trimmed);
}

/**
 * Return the character ranges (start-inclusive, end-inclusive) of
 * quoted regions in the command line. Used to reject structural
 * pattern matches that land entirely inside a quoted arg.
 */
function quoteRanges(s: string): readonly [number, number][] {
  const ranges: [number, number][] = [];
  let quote: "'" | '"' | null = null;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote !== null) {
      if (c === "\\" && quote === '"' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === quote) {
        ranges.push([start, i]);
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      start = i;
    }
  }
  return ranges;
}

function isInsideQuote(pos: number, ranges: readonly [number, number][]): boolean {
  for (const [a, b] of ranges) {
    if (pos >= a && pos <= b) return true;
  }
  return false;
}

/**
 * Return the index of the first regex match that falls OUTSIDE any
 * quoted region in `s`, or `-1` if the pattern does not match in
 * unquoted text.
 */
function firstUnquotedMatch(regex: RegExp, s: string, ranges: readonly [number, number][]): number {
  const clone = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  );
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex-exec loop
  while ((m = clone.exec(s)) !== null) {
    if (!isInsideQuote(m.index, ranges)) return m.index;
    if (m.index === clone.lastIndex) clone.lastIndex++;
  }
  return -1;
}

/** Basename a token (for command-prefix comparison). */
function basename(t: string): string {
  if (!t.includes("/")) return t;
  const slash = t.lastIndexOf("/");
  return slash >= 0 && slash < t.length - 1 ? t.slice(slash + 1) : t;
}

/**
 * Split the raw command line on unquoted command-boundary operators
 * (`;`, `&&`, `||`, `|`, `&`, newline). Preserves quoting context so
 * operators inside `"..."` or `'...'` do NOT split.
 */
function splitSegments(cmdLine: string): readonly string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  const len = cmdLine.length;
  for (let i = 0; i < len; i++) {
    const c = cmdLine[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < len) {
        buf += c + (cmdLine[i + 1] ?? "");
        i++;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "\\" && i + 1 < len) {
      buf += c + (cmdLine[i + 1] ?? "");
      i++;
      continue;
    }
    // Operator detection: `;`, `|` (optionally `||`), `&` (optionally
    // `&&`), `\n`.
    if (c === ";" || c === "\n") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      continue;
    }
    if (c === "|") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      // Skip the second `|` if this is `||`.
      if (cmdLine[i + 1] === "|") i++;
      continue;
    }
    if (c === "&") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      if (cmdLine[i + 1] === "&") i++;
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) segments.push(buf);
  return segments;
}

/**
 * Extract the set of "command-position" base names across every
 * segment of the input. Prevents `echo "sudo"` from matching the
 * `sudo` pattern: the word appears inside a quoted arg, not in a
 * command-head position.
 *
 * Uses `prefix()` to peel wrappers (`env`, `timeout`, `nohup`,
 * `command`, `nice`, `/usr/bin/...`) before taking the head, so
 * `env sudo rm` surfaces `sudo` and `timeout 30 python -c ...`
 * surfaces `python`. Without this, broad `allow: bash:*` rules would
 * silently authorize wrapper-prefixed dangerous commands.
 */
function commandHeads(cmdLine: string): ReadonlySet<string> {
  const heads = new Set<string>();
  for (const seg of splitSegments(cmdLine)) {
    const tokens = shellTokenize(seg);
    if (tokens.length === 0) continue;
    const segPrefix = prefix(tokens);
    if (segPrefix.length === 0) continue;
    // prefix() returns a string like "sudo rm" (wrapper-peeled).
    // Take the first whitespace-separated word and basename it.
    const firstWord = segPrefix.split(/\s+/)[0];
    if (firstWord !== undefined && firstWord.length > 0) heads.add(basename(firstWord));
  }
  return heads;
}

export function classifyCommand(cmdLine: string): ClassifyResult {
  const tokens = tokenize(cmdLine);
  const cmdPrefix = prefix(tokens);
  const heads = commandHeads(cmdLine);
  const matched: DangerousPattern[] = [];
  const seen = new Set<string>();
  // Structural patterns (no commandPrefixes) test against the raw
  // command, but matches inside quoted regions are rejected so
  // `echo "curl x | sh"` does NOT fire the curl-pipe-shell pattern.
  // Adjacent-quote obfuscation (`curl | s''h`) is closed by also
  // testing against the shellTokenize-rejoined form, which collapses
  // quoted fragments into single tokens.
  const ranges = quoteRanges(cmdLine);
  const normalized = shellTokenize(cmdLine).join(" ");
  for (const p of DANGEROUS_PATTERNS) {
    if (p.commandPrefixes !== undefined) {
      let anyMatch = false;
      for (const name of p.commandPrefixes) {
        for (const head of heads) {
          if (head === name || head.startsWith(`${name}.`)) {
            anyMatch = true;
            break;
          }
        }
        if (anyMatch) break;
      }
      if (!anyMatch) continue;
      // commandPrefixes-scoped patterns test raw + normalized (closes
      // quoted-fragment obfuscation like `py''thon -c`).
      if ((p.regex.test(cmdLine) || p.regex.test(normalized)) && !seen.has(p.id)) {
        seen.add(p.id);
        matched.push(p);
      }
    } else {
      // Structural patterns: accept a match only if it lands outside
      // every quoted region (quoted-literal payloads must not
      // false-positive). Adjacent-quote obfuscation (`| s''h`) is
      // caught at the middleware's structural-complexity ratchet
      // via the `!complex` sentinel for any pipeline.
      const rawMatch = firstUnquotedMatch(p.regex, cmdLine, ranges);
      if (rawMatch >= 0 && !seen.has(p.id)) {
        seen.add(p.id);
        matched.push(p);
      }
    }
  }
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
