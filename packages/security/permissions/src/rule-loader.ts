/**
 * Rule loader — multi-source precedence merge with Zod validation.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

import type { PermissionRule, RuleSource, SourcedRule } from "./rule-types.js";
import { SOURCE_PRECEDENCE } from "./rule-types.js";

const permissionRuleSchema = z.object({
  pattern: z.string().min(1),
  action: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
  reason: z.string().optional(),
});

const ruleArraySchema = z.array(permissionRuleSchema);

/**
 * Validate a single source's rules against the schema.
 */
function validateSourceRules(
  source: RuleSource,
  rules: readonly PermissionRule[],
): Result<readonly PermissionRule[], KoiError> {
  return validateWith(ruleArraySchema, rules, `Invalid ${source} permission rules`);
}

/**
 * Load and merge rules from multiple sources, sorted by precedence.
 *
 * Precedence order: policy > project > local > user.
 * Within each source, rules retain their original order.
 *
 * Returns a `Result` — validation failures produce a typed error
 * rather than throwing.
 */
export function loadRules(
  sources: ReadonlyMap<RuleSource, readonly PermissionRule[]>,
): Result<readonly SourcedRule[], KoiError> {
  const merged: SourcedRule[] = [];

  for (const source of SOURCE_PRECEDENCE) {
    const rules = sources.get(source);
    if (rules === undefined || rules.length === 0) {
      continue;
    }

    const validation = validateSourceRules(source, rules);
    if (!validation.ok) {
      return validation;
    }

    for (const rule of validation.value) {
      merged.push({ ...rule, source });
    }
  }

  return { ok: true, value: merged };
}
