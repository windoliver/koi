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

/**
 * Shell-normalized form of the command: tokens shell-tokenized (strips
 * surrounding quotes and collapses `py''thon`, `e""val` style quoted-
 * fragment concatenation) then rejoined with single spaces. Matching
 * patterns against this in addition to the raw string closes the
 * obvious quoting-obfuscation bypass where an adversary writes
 * `py''thon -c '...'` and evades the `\bpython\b` regex.
 */
function shellNormalized(cmdLine: string): string {
  const toks = shellTokenize(cmdLine);
  return toks.join(" ");
}

export function classifyCommand(cmdLine: string): ClassifyResult {
  const tokens = tokenize(cmdLine);
  const cmdPrefix = prefix(tokens);
  const normalized = shellNormalized(cmdLine);
  // Match against BOTH the raw string (preserves operators/spacing
  // patterns like `| sh`) AND the shell-normalized form (closes
  // quoted-fragment obfuscation). Union the matches.
  const seen = new Set<string>();
  const matched: DangerousPattern[] = [];
  for (const p of DANGEROUS_PATTERNS) {
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
