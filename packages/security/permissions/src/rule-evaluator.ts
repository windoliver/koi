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

function matchPrincipal(compiledPrincipal: RegExp | undefined, principal: string): boolean {
  if (compiledPrincipal === undefined) {
    return true;
  }
  return compiledPrincipal.test(principal);
}

/**
 * Normalize a resource string to prevent path traversal bypasses.
 *
 * - Collapses `//` to `/`
 * - Resolves `.` and `..` segments
 * - Preserves leading `/` for absolute paths
 *
 * Resources containing `..` that escape the root are collapsed to the root.
 * Non-path resources (e.g., `agent:foo`) pass through unchanged.
 */
export function normalizeResource(resource: string): string {
  // Non-path resources (no / at all) pass through as-is
  if (!resource.includes("/")) {
    return resource;
  }

  const isAbsolute = resource.startsWith("/");
  const segments = resource.split("/");
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === "." || seg === "") {
      continue;
    }
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  const normalized = resolved.join("/");
  return isAbsolute ? `/${normalized}` : normalized;
}

/**
 * Evaluate pre-compiled rules against a query. First matching rule wins.
 *
 * Resources are normalized before matching to prevent path traversal bypasses.
 * Returns `{ effect: "ask" }` when no rule matches.
 */
export function evaluateRules(
  query: PermissionQuery,
  rules: readonly CompiledRule[],
): PermissionDecision {
  const resource = normalizeResource(query.resource);

  for (const rule of rules) {
    if (
      matchPrincipal(rule.compiledPrincipal, query.principal) &&
      matchAction(rule.action, query.action) &&
      matchResource(rule.compiled, resource)
    ) {
      if (rule.effect === "allow") {
        return { effect: "allow" };
      }
      const reason = rule.reason ?? `Matched ${rule.source} rule: ${rule.pattern}`;
      return { effect: rule.effect, reason };
    }
  }

  return { effect: "ask", reason: "No matching permission rule" };
}
