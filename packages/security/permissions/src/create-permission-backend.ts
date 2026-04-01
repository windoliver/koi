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
  PLAN_DENIED_ACTIONS,
  PLAN_RULE_EVALUATED_ACTIONS,
} from "./rule-types.js";

const VALID_MODES = new Set(["default", "bypass", "plan", "auto"]);

/**
 * Create a stateless `PermissionBackend` from a permission config.
 *
 * Throws at construction time if the mode is invalid, preventing
 * misconfigured backends from silently failing at query time.
 */
export function createPermissionBackend(config: PermissionConfig): PermissionBackend {
  const { mode, rules } = config;

  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: "${mode}". Expected one of: default, bypass, plan, auto`,
    );
  }

  const planAllowed = config.planAllowedActions ?? PLAN_ALLOWED_ACTIONS;
  const planRuleEval = config.planRuleEvaluatedActions ?? PLAN_RULE_EVALUATED_ACTIONS;

  // Validate that custom plan action sets don't include mutating actions.
  for (const action of planAllowed) {
    if (PLAN_DENIED_ACTIONS.has(action)) {
      throw new Error(`Mutating action "${action}" cannot be added to planAllowedActions`);
    }
  }
  for (const action of planRuleEval) {
    if (PLAN_DENIED_ACTIONS.has(action)) {
      throw new Error(`Mutating action "${action}" cannot be added to planRuleEvaluatedActions`);
    }
  }

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
