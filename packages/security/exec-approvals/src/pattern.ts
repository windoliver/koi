/**
 * Compound pattern matching for @koi/exec-approvals.
 *
 * Patterns have two optional parts separated by the FIRST colon:
 *   "bash:cat /etc:shadow"  →  toolPattern="bash", inputPattern="cat /etc:shadow"
 *   "bash"                  →  toolPattern="bash", inputPattern=undefined (any input)
 *   "*"                     →  matches any tool, any input
 *   "bash:*"                →  matches bash with any input (including empty)
 *
 * Wildcards: only `*` at the end of a segment → prefix match.
 * `**` is normalized to `*` at construction time.
 */

import type { JsonObject } from "@koi/core/common";

/**
 * Normalize a pattern: replace `**` with `*` (once).
 */
export function normalizePattern(pattern: string): string {
  return pattern.replace(/\*\*/g, "*");
}

/**
 * Split a compound pattern on the FIRST colon only.
 * Returns [toolPattern, inputPattern | undefined].
 */
function splitPattern(pattern: string): readonly [string, string | undefined] {
  const colonIdx = pattern.indexOf(":");
  if (colonIdx === -1) {
    return [pattern, undefined];
  }
  return [pattern.slice(0, colonIdx), pattern.slice(colonIdx + 1)];
}

/**
 * Match a single string segment against a pattern segment.
 * Supports:
 * - Exact match: "bash"
 * - Wildcard: "*" (matches any string)
 * - Suffix wildcard: "git push*" (prefix match)
 */
function matchesSegment(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}

/**
 * Default command extractor: tries input.command, then input.args joined, then JSON.stringify.
 */
export function defaultExtractCommand(input: JsonObject): string {
  if (typeof input.command === "string") {
    return input.command;
  }
  if (Array.isArray(input.args)) {
    return (input.args as unknown[]).map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  }
  return JSON.stringify(input);
}

/**
 * Match a (toolId, input) pair against a compound pattern.
 *
 * @param pattern - Already-normalized compound pattern string
 * @param toolId  - Tool identifier to match against toolPattern part
 * @param input   - Tool input object; extractFn derives the command string
 * @param extractFn - Extracts a matchable string from input
 */
export function matchesCompoundPattern(
  pattern: string,
  toolId: string,
  input: JsonObject,
  extractFn: (input: JsonObject) => string,
): boolean {
  const [toolPattern, inputPattern] = splitPattern(pattern);

  if (!matchesSegment(toolId, toolPattern)) {
    return false;
  }

  if (inputPattern === undefined) {
    // No colon in pattern — matches any input for this tool
    return true;
  }

  const command = extractFn(input);
  return matchesSegment(command, inputPattern);
}

/**
 * Returns true if (toolId, input) matches any pattern in the list.
 */
export function matchesAnyCompound(
  patterns: readonly string[],
  toolId: string,
  input: JsonObject,
  extractFn: (input: JsonObject) => string,
): boolean {
  return patterns.some((p) => matchesCompoundPattern(p, toolId, input, extractFn));
}

/**
 * Returns the first matching ask pattern, or undefined if none match.
 */
export function findFirstAskMatch(
  askPatterns: readonly string[],
  toolId: string,
  input: JsonObject,
  extractFn: (input: JsonObject) => string,
): string | undefined {
  return askPatterns.find((p) => matchesCompoundPattern(p, toolId, input, extractFn));
}
