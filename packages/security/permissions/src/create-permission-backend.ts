/**
 * Permission backend factory — assembles rule evaluator + mode resolver
 * into a concrete PermissionBackend implementation.
 *
 * Rules are compiled from string patterns internally — callers never
 * supply precompiled regexes, preventing injected compiled state.
 */

import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";

import type { PlanModeOptions } from "./mode-resolver.js";
import { resolveMode } from "./mode-resolver.js";
import { compileGlob } from "./rule-evaluator.js";
import type { CompiledRule, PermissionConfig, SourcedRule } from "./rule-types.js";
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
 * Recursively freeze an object and all nested objects.
 */
function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Compile a sourced rule's glob patterns to RegExp.
 * Throws on invalid glob patterns.
 */
function compileRule(rule: SourcedRule): CompiledRule {
  const compiled = compileGlob(rule.pattern);
  const compiledPrincipal =
    rule.principal !== undefined && rule.principal !== "*"
      ? compileGlob(rule.principal)
      : undefined;
  const compiledContext =
    rule.context !== undefined
      ? Object.fromEntries(Object.entries(rule.context).map(([k, v]) => [k, compileGlob(v)]))
      : undefined;
  return { ...rule, compiled, compiledPrincipal, compiledContext };
}

/**
 * Compile, deep-freeze, and seal a rules array.
 * Throws on invalid glob patterns in any rule.
 */
function compileAndFreezeRules(rules: readonly SourcedRule[]): readonly CompiledRule[] {
  const compiled = rules.map(compileRule);
  for (const rule of compiled) {
    deepFreeze(rule);
  }
  return Object.freeze(compiled);
}

/**
 * Create a stateless `PermissionBackend` from a permission config.
 *
 * Rules are compiled from string patterns internally — precompiled
 * regexes from callers are ignored. All inputs are defensively copied
 * and frozen at construction time.
 *
 * Throws at construction time if the mode is invalid, glob patterns
 * are malformed, or plan-mode action sets contain actions outside
 * the approved read-only vocabulary.
 */
export function createPermissionBackend(config: PermissionConfig): PermissionBackend {
  const { mode } = config;

  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: "${mode}". Expected one of: default, bypass, plan, auto`,
    );
  }

  // Compile rules from string patterns — never trust precompiled state.
  const rules = compileAndFreezeRules(config.rules);

  // Defensive copy of plan action sets from caller-provided arrays.
  const planAllowed = new Set(config.planAllowedActions ?? PLAN_ALLOWED_ACTIONS);
  const planRuleEval = new Set(config.planRuleEvaluatedActions ?? PLAN_RULE_EVALUATED_ACTIONS);

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
