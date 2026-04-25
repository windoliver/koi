/**
 * `classifyCommand(cmdLine)` — structural classification entry point.
 *
 * Pipeline:
 *   1. Compute canonical permission prefix via `canonicalPrefix`.
 *   2. Build command contexts across wrapper-revealed executables and nested
 *      command forms (`shell -c`, `$(...)`, process substitution, backticks).
 *   3. Test every `DANGEROUS_PATTERNS` entry against those contexts.
 *   4. Aggregate worst severity.
 *
 * Pure function. No I/O. No side effects.
 */

import {
  type CollectedCommandContexts,
  type CommandContext,
  collectCommandContexts,
  hasShellDashCInvocation,
} from "./command-contexts.js";
import { DANGEROUS_PATTERNS } from "./patterns.js";
import { canonicalPrefix } from "./prefix.js";
import type { ClassifyResult, DangerousPattern, Severity } from "./types.js";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const CLASSIFIER_BUDGET_EXCEEDED: DangerousPattern = Object.freeze({
  id: "classifier-budget-exceeded",
  regex: /\b\B/,
  category: "code-exec",
  severity: "high",
  message: "Shell nesting exceeded classifier budget; manual review required",
});

const COMPOUND_SHELL_STRUCTURE: DangerousPattern = Object.freeze({
  id: "compound-shell-structure",
  regex: /\b\B/,
  category: "code-exec",
  severity: "high",
  message: "Compound shell control flow requires manual review",
});

const SHELL_FUNCTION_DEFINITION: DangerousPattern = Object.freeze({
  id: "shell-function-definition",
  regex: /\b\B/,
  category: "code-exec",
  severity: "high",
  message: "Shell function definitions require manual review",
});

const COMPOUND_SHELL_OPENERS = new Set(["if", "for", "while", "until", "case", "select"]);
const COMPOUND_SHELL_FOLLOWERS = new Set(["then", "elif", "else", "fi", "do", "done", "esac"]);

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

function hasScopedPrefix(context: CommandContext, commandPrefixes: readonly string[]): boolean {
  for (const name of commandPrefixes) {
    for (const head of context.heads) {
      if (head === name || head.startsWith(`${name}.`)) {
        return true;
      }
    }
  }
  return false;
}

function stripShellKeywordToken(token: string): string {
  let current = token;
  while (current.startsWith("(") || current.startsWith("{")) {
    current = current.slice(1);
  }
  while (current.endsWith(";") || current.endsWith(")") || current.endsWith("}")) {
    current = current.slice(0, -1);
  }
  return current;
}

function hasCompoundShellStructure(contexts: readonly CommandContext[]): boolean {
  for (const context of contexts) {
    let sawOpener = false;
    let sawFollower = false;
    let quote: "'" | '"' | null = null;
    let buf = "";
    const flush = (): boolean => {
      const token = stripShellKeywordToken(buf);
      buf = "";
      if (token.length === 0) return false;
      if (COMPOUND_SHELL_OPENERS.has(token)) sawOpener = true;
      if (COMPOUND_SHELL_FOLLOWERS.has(token)) sawFollower = true;
      return sawOpener && sawFollower;
    };

    for (let i = 0; i < context.raw.length; i++) {
      const c = context.raw[i];
      if (c === undefined) break;

      if (quote === "'") {
        if (c === "'") quote = null;
        continue;
      }

      if (quote === '"') {
        if (c === '"') quote = null;
        else if (c === "\\" && i + 1 < context.raw.length) i++;
        continue;
      }

      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }

      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "(" ||
        c === ")" ||
        c === "{" ||
        c === "}"
      ) {
        if (flush()) return true;
        continue;
      }

      buf += c;
    }

    if (flush()) return true;
    if (sawOpener && sawFollower) return true;
    sawOpener = false;
    sawFollower = false;
    buf = "";
    quote = null;
  }
  return false;
}

const SHELL_FUNCTION_REGEX =
  /(?:\bfunction\s+[^\s(){};]+\s*(?:\(\s*\))?\s*\{|(?:^|[;&(\n]\s*)[^\s(){};]+\s*\(\s*\)\s*\{)/;

function hasShellFunctionDefinition(contexts: readonly CommandContext[]): boolean {
  for (const context of contexts) {
    const ranges = quoteRanges(context.raw);
    if (firstUnquotedMatch(SHELL_FUNCTION_REGEX, context.raw, ranges) >= 0) {
      return true;
    }
  }
  return false;
}

function matchesPatternInContext(pattern: DangerousPattern, context: CommandContext): boolean {
  if (pattern.commandPrefixes !== undefined && !hasScopedPrefix(context, pattern.commandPrefixes)) {
    return false;
  }

  if (pattern.id === "shell-dash-c") {
    return hasShellDashCInvocation(context.raw);
  }

  if (pattern.commandPrefixes !== undefined) {
    return pattern.regex.test(context.raw) || pattern.regex.test(context.normalized);
  }

  const ranges = quoteRanges(context.raw);
  return firstUnquotedMatch(pattern.regex, context.raw, ranges) >= 0;
}

export function classifyCommand(cmdLine: string): ClassifyResult {
  const trimmed = cmdLine.trim();
  if (trimmed.length === 0) {
    return {
      prefix: "",
      matchedPatterns: [],
      severity: null,
    };
  }

  const cmdPrefix = canonicalPrefix(trimmed);
  const { contexts, truncated }: CollectedCommandContexts = collectCommandContexts(trimmed);
  const matched: DangerousPattern[] = [];
  const seen = new Set<string>();
  for (const p of DANGEROUS_PATTERNS) {
    for (const context of contexts) {
      if (matchesPatternInContext(p, context) && !seen.has(p.id)) {
        seen.add(p.id);
        matched.push(p);
        break;
      }
    }
  }
  if (truncated && !seen.has(CLASSIFIER_BUDGET_EXCEEDED.id)) {
    seen.add(CLASSIFIER_BUDGET_EXCEEDED.id);
    matched.push(CLASSIFIER_BUDGET_EXCEEDED);
  }
  if (hasCompoundShellStructure(contexts) && !seen.has(COMPOUND_SHELL_STRUCTURE.id)) {
    seen.add(COMPOUND_SHELL_STRUCTURE.id);
    matched.push(COMPOUND_SHELL_STRUCTURE);
  }
  if (hasShellFunctionDefinition(contexts) && !seen.has(SHELL_FUNCTION_DEFINITION.id)) {
    seen.add(SHELL_FUNCTION_DEFINITION.id);
    matched.push(SHELL_FUNCTION_DEFINITION);
  }
  return {
    prefix: cmdPrefix,
    matchedPatterns: matched,
    severity: worstSeverity(matched),
  };
}
