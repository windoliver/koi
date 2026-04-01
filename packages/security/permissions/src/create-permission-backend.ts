/**
 * Permission backend factory — assembles rule evaluator + mode resolver
 * into a concrete PermissionBackend implementation.
 */

import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";

import type { PlanModeOptions } from "./mode-resolver.js";
import { resolveMode } from "./mode-resolver.js";
import type { CompiledRule, PermissionConfig } from "./rule-types.js";
import {
  PLAN_ALLOWED_ACTIONS,
  PLAN_RULE_EVALUATED_ACTIONS,
  PLAN_SAFE_VOCABULARY,
} from "./rule-types.js";

const VALID_MODES = new Set(["default", "bypass", "plan", "auto"]);

// Private Set built from the exported frozen array — cannot be mutated by callers.
const safeVocabularySet = new Set(PLAN_SAFE_VOCABULARY);

/**
 * Validate that every action in a set is in the approved read-only vocabulary.
 */
function validatePlanActions(actions: ReadonlySet<string>, label: string): void {
  for (const action of actions) {
    if (!safeVocabularySet.has(action)) {
      throw new Error(
        `Action "${action}" is not in the approved read-only vocabulary for ${label}. ` +
          `Allowed: ${PLAN_SAFE_VOCABULARY.join(", ")}`,
      );
    }
  }
}

/**
 * Deep-freeze a rules array so neither the array nor individual rule objects
 * can be mutated after backend construction.
 */
function freezeRules(rules: readonly CompiledRule[]): readonly CompiledRule[] {
  const frozen = [...rules];
  for (const rule of frozen) {
    Object.freeze(rule);
  }
  return Object.freeze(frozen);
}

/**
 * Create a stateless `PermissionBackend` from a permission config.
 *
 * All mutable inputs (rules, action sets) are defensively copied and frozen
 * at construction time. Post-construction mutation of the caller's original
 * objects has no effect on the backend's behavior.
 *
 * Throws at construction time if the mode is invalid or plan-mode action
 * sets contain actions outside the approved read-only vocabulary.
 */
export function createPermissionBackend(config: PermissionConfig): PermissionBackend {
  const { mode } = config;

  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: "${mode}". Expected one of: default, bypass, plan, auto`,
    );
  }

  // Defensive copy of rules — caller cannot mutate after construction.
  const rules = freezeRules(config.rules);

  // Defensive copy of plan action sets from caller-provided arrays.
  const planAllowed = new Set(config.planAllowedActions ?? PLAN_ALLOWED_ACTIONS);
  const planRuleEval = new Set(config.planRuleEvaluatedActions ?? PLAN_RULE_EVALUATED_ACTIONS);

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
