/**
 * Mode resolver — maps permission mode + query to a decision.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import { evaluateRules } from "./rule-evaluator.js";
import type { CompiledRule, PermissionMode } from "./rule-types.js";
import { PLAN_ALLOWED_ACTIONS } from "./rule-types.js";

/**
 * Resolve a permission decision based on the active mode.
 *
 * - `"bypass"` — always allow
 * - `"plan"`   — deny-by-default; only explicitly allowed read-only actions pass
 * - `"default"` — evaluate rules, fallback to ask
 * - `"auto"`   — evaluate rules, fallback to allow
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
      if (PLAN_ALLOWED_ACTIONS.has(query.action)) {
        return { effect: "allow" };
      }
      return { effect: "deny", reason: "Only read-only actions are allowed in plan mode" };
    }

    case "default": {
      return evaluateRules(query, rules);
    }

    case "auto": {
      const decision = evaluateRules(query, rules);
      // In auto mode, convert ask → allow (classifier in #1236 may override)
      if (decision.effect === "ask") {
        return { effect: "allow" };
      }
      return decision;
    }
  }
}
