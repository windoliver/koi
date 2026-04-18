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
  return trimmed.split(/\s+/);
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
  for (const p of DANGEROUS_PATTERNS) {
    // Patterns with `commandPrefixes` only fire when one of the
    // listed names actually appears in command position. Keeps
    // `echo "sudo"` from matching the `sudo` pattern.
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
    }
    // Regex runs on raw (operator/pipeline context) AND on a
    // shell-normalized view (closes quoted-fragment obfuscation
    // like `py''thon -c`).
    const normalized = shellTokenize(cmdLine).join(" ");
    if ((p.regex.test(cmdLine) || p.regex.test(normalized)) && !seen.has(p.id)) {
      seen.add(p.id);
      matched.push(p);
    }
  }
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
