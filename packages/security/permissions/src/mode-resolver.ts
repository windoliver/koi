/**
 * Mode resolver — maps permission mode + query to a decision.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import { evaluateRules } from "./rule-evaluator.js";
import type { CompiledRule, PermissionMode } from "./rule-types.js";
import { PLAN_ALLOWED_ACTIONS, PLAN_RULE_EVALUATED_ACTIONS } from "./rule-types.js";

/**
 * Resolve a permission decision based on the active mode.
 *
 * - `"bypass"` — always allow
 * - `"plan"`   — deny-by-default; read-only actions auto-allow with explicit rules,
 *                rule-evaluated actions (discover) require explicit allow rules
 * - `"default"` — evaluate rules, fallback to ask
 * - `"auto"`   — evaluate rules, fallback to ask (classifier in #1236 may promote to allow)
 */
export function resolveMode(
  mode: PermissionMode,
  query: PermissionQuery,
  rules: readonly CompiledRule[],
): PermissionDecision {
  switch (mode) {
    case "bypass":
      return { effect: "allow" };

    case "plan": {
      // Read-only actions and rule-evaluated actions go through rule evaluation.
      // All other actions (writes, bash, etc.) are unconditionally denied.
      if (
        !PLAN_ALLOWED_ACTIONS.has(query.action) &&
        !PLAN_RULE_EVALUATED_ACTIONS.has(query.action)
      ) {
        return { effect: "deny", reason: "Only read-only actions are allowed in plan mode" };
      }
      // Evaluate rules. Deny and ask propagate;
      // only an explicit allow rule permits the action.
      const ruleDecision = evaluateRules(query, rules);
      if (ruleDecision.effect === "deny" || ruleDecision.effect === "ask") {
        return ruleDecision;
      }
      return { effect: "allow" };
    }

    case "default": {
      return evaluateRules(query, rules);
    }

    case "auto": {
      // Evaluate rules. Explicit allow/deny propagate as-is.
      // Unmatched (ask) stays as ask — the classifier in #1236 may promote to allow.
      return evaluateRules(query, rules);
    }

    default:
      // Fail closed on unknown mode values (e.g., bad JSON config at runtime).
      return { effect: "deny", reason: `Unknown permission mode: ${mode as string}` };
  }
}
