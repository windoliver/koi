/**
 * Permission backend factory — assembles rule evaluator + mode resolver
 * into a concrete PermissionBackend implementation.
 */

import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";

import type { PlanModeOptions } from "./mode-resolver.js";
import { resolveMode } from "./mode-resolver.js";
import type { PermissionConfig } from "./rule-types.js";
import {
  PLAN_ALLOWED_ACTIONS,
  PLAN_RULE_EVALUATED_ACTIONS,
  PLAN_SAFE_VOCABULARY,
} from "./rule-types.js";

const VALID_MODES = new Set(["default", "bypass", "plan", "auto"]);

/**
 * Validate that every action in a set is in the approved read-only vocabulary.
 * Throws with a descriptive message if any action is not recognized as safe.
 */
function validatePlanActions(actions: ReadonlySet<string>, label: string): void {
  for (const action of actions) {
    if (!PLAN_SAFE_VOCABULARY.has(action)) {
      throw new Error(
        `Action "${action}" is not in the approved read-only vocabulary for ${label}. ` +
          `Allowed: ${[...PLAN_SAFE_VOCABULARY].join(", ")}`,
      );
    }
  }
}

/**
 * Create a stateless `PermissionBackend` from a permission config.
 *
 * Throws at construction time if the mode is invalid or plan-mode action
 * sets contain actions outside the approved read-only vocabulary.
 */
export function createPermissionBackend(config: PermissionConfig): PermissionBackend {
  const { mode, rules } = config;

  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: "${mode}". Expected one of: default, bypass, plan, auto`,
    );
  }

  // Defensive copy + freeze — caller cannot mutate sets after construction.
  const planAllowed = Object.freeze(new Set(config.planAllowedActions ?? PLAN_ALLOWED_ACTIONS));
  const planRuleEval = Object.freeze(
    new Set(config.planRuleEvaluatedActions ?? PLAN_RULE_EVALUATED_ACTIONS),
  );

  // Validate all actions are in the approved read-only vocabulary.
  validatePlanActions(planAllowed, "planAllowedActions");
  validatePlanActions(planRuleEval, "planRuleEvaluatedActions");

  const planOptions: PlanModeOptions = {
    allowedActions: planAllowed,
    ruleEvaluatedActions: planRuleEval,
  };

  function check(query: PermissionQuery): PermissionDecision {
    return resolveMode(mode, query, rules, planOptions);
  }

  function checkBatch(queries: readonly PermissionQuery[]): readonly PermissionDecision[] {
    return queries.map(check);
  }

  function dispose(): void {
    // Stateless — nothing to clean up.
  }

  return { check, checkBatch, dispose };
}
