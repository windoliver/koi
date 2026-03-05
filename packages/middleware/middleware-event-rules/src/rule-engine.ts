/**
 * Rule engine — evaluates compiled rules against events.
 *
 * Session-scoped, in-memory counter state with sorted-array storage
 * and binary-search prune-on-read. No background timers.
 */

import type {
  CompiledRule,
  CompiledRuleset,
  ResolvedAction,
  RuleEngine,
  RuleEvalResult,
  RuleEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum counter entries per rule to bound memory. */
const MAX_COUNTER_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Counter helpers (sorted array + binary search)
// ---------------------------------------------------------------------------

/**
 * Finds the first index in a sorted array where `arr[i] >= threshold`.
 * Returns `arr.length` if all elements are below threshold.
 */
function lowerBound(arr: readonly number[], threshold: number): number {
  // let is justified: binary search loop variable
  let lo = 0;
  // let is justified: binary search loop variable
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: mid is bounded by arr.length
    if (arr[mid]! < threshold) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// RuleEngine
// ---------------------------------------------------------------------------

/**
 * Creates a rule engine for a compiled ruleset.
 *
 * @param ruleset - Pre-compiled and indexed ruleset.
 * @param now - Injectable clock (default: Date.now).
 */
export function createRuleEngine(
  ruleset: CompiledRuleset,
  now: () => number = Date.now,
): RuleEngine {
  /** Counter state: rule name → sorted array of timestamps. */
  const counters = new Map<string, number[]>();

  function getCount(ruleName: string, windowMs: number): number {
    const timestamps = counters.get(ruleName);
    if (timestamps === undefined) return 0;

    const threshold = now() - windowMs;
    const startIdx = lowerBound(timestamps, threshold);

    // Prune expired entries
    if (startIdx > 0) {
      timestamps.splice(0, startIdx);
    }

    return timestamps.length;
  }

  function incrementCounter(ruleName: string): void {
    const timestamps = counters.get(ruleName);
    const currentTime = now();

    if (timestamps === undefined) {
      counters.set(ruleName, [currentTime]);
      return;
    }

    // Enforce max entries by dropping oldest
    if (timestamps.length >= MAX_COUNTER_ENTRIES) {
      timestamps.splice(0, 1);
    }

    timestamps.push(currentTime);
  }

  function matchesPredicate(
    rule: CompiledRule,
    fields: Readonly<Record<string, unknown>>,
  ): boolean {
    for (const pred of rule.predicates) {
      if (!pred.test(fields[pred.field])) return false;
    }
    return true;
  }

  function evaluate(event: RuleEvent): RuleEvalResult {
    const rules = ruleset.byEventType.get(event.type);
    if (rules === undefined) {
      return { actions: [], skipToolIds: [] };
    }

    const actions: ResolvedAction[] = [];
    const skipToolIds: string[] = [];

    for (const rule of rules) {
      if (!matchesPredicate(rule, event.fields)) continue;

      // Check windowed condition
      if (rule.condition !== undefined) {
        incrementCounter(rule.name);
        const count = getCount(rule.name, rule.condition.windowMs);
        if (count < rule.condition.count) continue;
      }

      // Collect actions
      for (const action of rule.actions) {
        actions.push({ ruleName: rule.name, action });
        if (action.type === "skip_tool" && action.toolId !== undefined) {
          skipToolIds.push(action.toolId);
        }
      }

      if (rule.stopOnMatch) break;
    }

    return { actions, skipToolIds };
  }

  function reset(): void {
    counters.clear();
  }

  return { evaluate, reset };
}
