/**
 * Rule loader — multi-source precedence merge with Zod validation
 * and glob compilation at load time.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

import { compileGlob } from "./rule-evaluator.js";
import type { CompiledRule, PermissionRule, RuleSource } from "./rule-types.js";
import { SOURCE_PRECEDENCE } from "./rule-types.js";

const permissionRuleSchema = z.object({
  pattern: z.string().min(1),
  action: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
  principal: z.string().min(1).optional(),
  context: z.record(z.string(), z.string().min(1)).optional(),
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
 * Compile a sourced rule's glob pattern to a RegExp.
 * Returns a typed error if the pattern produces invalid regex.
 */
function compileRule(rule: PermissionRule, source: RuleSource): Result<CompiledRule, KoiError> {
  try {
    const compiled = compileGlob(rule.pattern);
    const compiledPrincipal =
      rule.principal !== undefined && rule.principal !== "*"
        ? compileGlob(rule.principal)
        : undefined;
    const compiledContext =
      rule.context !== undefined
        ? Object.fromEntries(Object.entries(rule.context).map(([k, v]) => [k, compileGlob(v)]))
        : undefined;
    return { ok: true, value: { ...rule, source, compiled, compiledPrincipal, compiledContext } };
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid glob pattern in ${source} rules: "${rule.pattern}"`,
        retryable: false,
        context: { source, pattern: rule.pattern },
      },
    };
  }
}

/**
 * Load and merge rules from multiple sources, sorted by precedence.
 * Glob patterns are compiled to RegExp at load time — invalid patterns
 * produce a typed error rather than crashing at evaluation time.
 *
 * Precedence order: policy > project > local > user.
 * Within each source, rules retain their original order.
 */
export function loadRules(
  sources: ReadonlyMap<RuleSource, readonly PermissionRule[]>,
): Result<readonly CompiledRule[], KoiError> {
  const merged: CompiledRule[] = [];

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
      const compiled = compileRule(rule, source);
      if (!compiled.ok) {
        return compiled;
      }
      merged.push(compiled.value);
    }
  }

  return { ok: true, value: merged };
}
