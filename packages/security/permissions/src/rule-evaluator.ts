/**
 * Rule evaluator — glob + action matching with first-match-wins semantics.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import type { CompiledRule } from "./rule-types.js";

/**
 * Test whether a resource path matches a compiled glob regex.
 */
function matchResource(compiled: RegExp, resource: string): boolean {
  return compiled.test(resource);
}

/**
 * Convert a glob pattern string to a RegExp.
 *
 * Supports:
 * - `*`  matches any single path segment (no `/`)
 * - `**` matches zero or more path segments (including `/`)
 * - Literal characters match exactly
 *
 * Throws `SyntaxError` if the resulting regex is invalid.
 */
export function compileGlob(pattern: string): RegExp {
  let result = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern.charAt(i);

    if (char === "*" && pattern.charAt(i + 1) === "*") {
      i += 2;
      if (pattern.charAt(i) === "/") {
        // `**/` — match zero or more path segments followed by separator
        result += "(?:.*/)?";
        i += 1;
      } else {
        // `**` at end — match anything remaining
        result += ".*";
      }
    } else if (char === "*") {
      result += "[^/]*";
      i += 1;
    } else {
      // All non-glob characters (including ?, [, ]) are escaped as literals.
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
 * Evaluate pre-compiled rules against a query. First matching rule wins.
 *
 * Returns `{ effect: "ask" }` when no rule matches.
 */
export function evaluateRules(
  query: PermissionQuery,
  rules: readonly CompiledRule[],
): PermissionDecision {
  for (const rule of rules) {
    if (matchAction(rule.action, query.action) && matchResource(rule.compiled, query.resource)) {
      if (rule.effect === "allow") {
        return { effect: "allow" };
      }
      const reason = rule.reason ?? `Matched ${rule.source} rule: ${rule.pattern}`;
      return { effect: rule.effect, reason };
    }
  }

  return { effect: "ask", reason: "No matching permission rule" };
}
