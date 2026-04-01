/**
 * Rule evaluator — glob + action matching with first-match-wins semantics.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import type { SourcedRule } from "./rule-types.js";

/**
 * Test whether a resource path matches a glob pattern.
 *
 * Supports:
 * - `*`  matches any single path segment (no `/`)
 * - `**` matches zero or more path segments (including `/`)
 * - Literal characters match exactly
 */
export function matchGlob(pattern: string, resource: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(resource);
}

function globToRegex(pattern: string): RegExp {
  let result = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern.charAt(i);

    if (char === "*" && pattern.charAt(i + 1) === "*") {
      // `**` — match anything including path separators
      result += ".*";
      i += 2;
      // Skip trailing `/` after `**`
      if (pattern.charAt(i) === "/") {
        i += 1;
      }
    } else if (char === "*") {
      // `*` — match anything except `/`
      result += "[^/]*";
      i += 1;
    } else if (char === "?" || char === "[" || char === "]") {
      // Pass through basic glob characters
      result += char;
      i += 1;
    } else {
      // Escape regex special characters
      result += escapeRegex(char);
      i += 1;
    }
  }

  result += "$";
  return new RegExp(result);
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchAction(ruleAction: string, queryAction: string): boolean {
  return ruleAction === "*" || ruleAction === queryAction;
}

/**
 * Evaluate pre-sorted rules against a query. First matching rule wins.
 *
 * Returns `{ effect: "ask" }` when no rule matches.
 */
export function evaluateRules(
  query: PermissionQuery,
  rules: readonly SourcedRule[],
): PermissionDecision {
  for (const rule of rules) {
    if (matchAction(rule.action, query.action) && matchGlob(rule.pattern, query.resource)) {
      if (rule.effect === "allow") {
        return { effect: "allow" };
      }
      const reason = rule.reason ?? `Matched ${rule.source} rule: ${rule.pattern}`;
      return { effect: rule.effect, reason };
    }
  }

  return { effect: "ask", reason: "No matching permission rule" };
}
