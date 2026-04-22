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
  principal: z.string().min(1).optional(),
  context: z.record(z.string(), z.string().min(1)).optional(),
  reason: z.string().optional(),
  on_deny: z.enum(["hard", "soft"]).optional(),
});

const semanticEffectFields = {
  effect: z.enum(["allow", "deny", "ask"]),
  principal: z.string().min(1).optional(),
  context: z.record(z.string(), z.string().min(1)).optional(),
  reason: z.string().optional(),
  on_deny: z.enum(["hard", "soft"]).optional(),
};

const semanticWriteSchema = z
  .object({ Write: z.string().min(1), ...semanticEffectFields })
  .transform(({ Write, ...rest }) => ({ pattern: Write, action: "write" as const, ...rest }));

const semanticReadSchema = z
  .object({ Read: z.string().min(1), ...semanticEffectFields })
  .transform(({ Read, ...rest }) => ({ pattern: Read, action: "read" as const, ...rest }));

const semanticNetworkSchema = z
  .object({ Network: z.string().min(1), ...semanticEffectFields })
  .transform(({ Network, ...rest }) => ({ pattern: Network, action: "network" as const, ...rest }));

const anyRuleSchema = z.union([
  semanticWriteSchema,
  semanticReadSchema,
  semanticNetworkSchema,
  permissionRuleSchema,
]);

const ruleArraySchema = z.array(anyRuleSchema);

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
 * Validates each source against the schema. Normalizes backslashes
 * in patterns to forward slashes for platform-agnostic matching.
 *
 * Precedence order: policy > project > local > user.
 * Within each source, rules retain their original order.
 *
 * Returns `SourcedRule[]` — compilation to regex happens inside
 * `createPermissionBackend()` to prevent injected compiled state.
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
      // Normalize backslashes so rules match normalized resources on all platforms.
      const normalizedPattern = rule.pattern.replaceAll("\\", "/");
      merged.push({ ...rule, pattern: normalizedPattern, source });
    }
  }

  return { ok: true, value: merged };
}
