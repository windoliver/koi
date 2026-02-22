/**
 * Permission engine interfaces and default implementations.
 */

import type { JsonObject } from "@koi/core/common";

export type PermissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }
  | { readonly allowed: "ask"; readonly reason: string };

export interface PermissionRules {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

export interface PermissionEngine {
  readonly check: (toolId: string, input: JsonObject, rules: PermissionRules) => PermissionDecision;
}

export interface ApprovalHandler {
  readonly requestApproval: (toolId: string, input: JsonObject, reason: string) => Promise<boolean>;
}

/**
 * Matches a tool ID against a glob-like pattern.
 * Supports:
 * - Exact match: "my-tool"
 * - Wildcard: "*" (matches everything)
 * - Prefix wildcard: "fs:*" (matches "fs:read", "fs:write", etc.)
 */
function matchesPattern(toolId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolId.startsWith(prefix);
  }
  return toolId === pattern;
}

function matchesAny(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(toolId, p));
}

/**
 * Pattern-based permission engine.
 * Evaluation order: deny-first, then ask, then allow, then defaultDeny.
 */
export function createPatternPermissionEngine(defaultDeny: boolean = true): PermissionEngine {
  return {
    check(toolId: string, _input: JsonObject, rules: PermissionRules): PermissionDecision {
      // Deny takes precedence
      if (matchesAny(toolId, rules.deny)) {
        return { allowed: false, reason: `Tool "${toolId}" is denied by policy` };
      }

      // Ask takes next precedence
      if (matchesAny(toolId, rules.ask)) {
        return { allowed: "ask", reason: `Tool "${toolId}" requires approval` };
      }

      // Allow
      if (matchesAny(toolId, rules.allow)) {
        return { allowed: true };
      }

      // Default
      if (defaultDeny) {
        return {
          allowed: false,
          reason: `Tool "${toolId}" is not in the allow list (default deny)`,
        };
      }

      return { allowed: true };
    },
  };
}

/**
 * Auto-approval handler for testing and development.
 * Always approves all requests.
 */
export function createAutoApprovalHandler(): ApprovalHandler {
  return {
    requestApproval: async (
      _toolId: string,
      _input: JsonObject,
      _reason: string,
    ): Promise<boolean> => true,
  };
}
