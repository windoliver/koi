import type { ResolvedCompat } from "./types.js";

export interface ModelCompatRule {
  readonly match: RegExp;
  readonly overrides: Partial<ResolvedCompat>;
}

export const MODEL_COMPAT_RULES: readonly ModelCompatRule[] = [] as const;

export function applyModelCompatRules(
  model: string,
  base: ResolvedCompat,
  rules: readonly ModelCompatRule[] = MODEL_COMPAT_RULES,
): ResolvedCompat {
  for (const rule of rules) {
    // Reset lastIndex before test() — global/sticky regexes mutate lastIndex,
    // which would cause the same model string to alternate match/no-match across calls.
    rule.match.lastIndex = 0;
    if (rule.match.test(model)) {
      return { ...base, ...rule.overrides };
    }
  }
  return base;
}
