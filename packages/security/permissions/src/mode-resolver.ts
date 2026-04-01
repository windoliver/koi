/**
 * Mode resolver — maps permission mode + query to a decision.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import { evaluateRules } from "./rule-evaluator.js";
import type { PermissionMode, SourcedRule } from "./rule-types.js";
import { WRITE_ACTIONS } from "./rule-types.js";

/**
 * Resolve a permission decision based on the active mode.
 *
 * - `"bypass"` — always allow
 * - `"plan"`   — deny write actions, allow reads
 * - `"default"` — evaluate rules, fallback to ask
 * - `"auto"`   — evaluate rules, fallback to allow
 */
export function resolveMode(
  mode: PermissionMode,
  query: PermissionQuery,
  rules: readonly SourcedRule[],
): PermissionDecision {
  switch (mode) {
    case "bypass":
      return { effect: "allow" };

    case "plan": {
      if (WRITE_ACTIONS.has(query.action)) {
        return { effect: "deny", reason: "Write actions are denied in plan mode" };
      }
      return { effect: "allow" };
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
