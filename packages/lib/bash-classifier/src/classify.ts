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
import { prefix } from "./prefix.js";
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

export function classifyCommand(cmdLine: string): ClassifyResult {
  const tokens = tokenize(cmdLine);
  const cmdPrefix = prefix(tokens);
  const matched = DANGEROUS_PATTERNS.filter((p) => p.regex.test(cmdLine));
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
