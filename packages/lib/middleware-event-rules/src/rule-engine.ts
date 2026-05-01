/**
 * Rule engine — evaluates compiled rules against events.
 *
 * Session-scoped, in-memory counter state with sorted-array storage and
 * binary-search prune-on-read. No background timers.
 */

import type {
  CompiledRule,
  CompiledRuleset,
  ResolvedAction,
  RuleEngine,
  RuleEvalResult,
  RuleEvent,
  SkipDirective,
} from "./types.js";

/** Maximum counter entries per rule to bound memory. */
export const MAX_COUNTER_ENTRIES = 1000;

/** First index `i` where `arr[i] >= threshold`; `arr.length` if all below. */
function lowerBound(arr: readonly number[], threshold: number): number {
  // let justified: binary search loop variables
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v !== undefined && v < threshold) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Counter partitioning: tool_call events partition by `rule.name + toolId`
 * so multi-tool rules (regex/oneOf match on `toolId`) maintain a separate
 * window per matched tool. Other event types use `rule.name` directly —
 * session/turn-scoped events have no natural sub-partition.
 */
function counterKeyFor(ruleName: string, event: RuleEvent): string {
  if (event.type !== "tool_call") return ruleName;
  const toolId = event.fields.toolId;
  return typeof toolId === "string" ? `${ruleName}|${toolId}` : ruleName;
}

/**
 * Allowlist of fields safe to expose to action templates. Flat tool-input
 * fields are deliberately excluded so a templated `log`/`notify`/`emit`/
 * `escalate` message cannot exfiltrate secrets that happen to live in
 * tool arguments. Predicates may still match against any input field.
 */
const SAFE_RENDER_KEYS = [
  "toolId",
  "ok",
  "blocked",
  "blockedByHook",
  "reason",
  "agentId",
  "sessionId",
  "turnIndex",
  "userId",
  "channelId",
] as const;

function pickSafeFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of SAFE_RENDER_KEYS) {
    if (k in fields) out[k] = fields[k];
  }
  return out;
}

export function createRuleEngine(
  ruleset: CompiledRuleset,
  now: () => number = Date.now,
): RuleEngine {
  const counters = new Map<string, number[]>();
  /** Last fire timestamp per rule, used for per-window dedupe. */
  const lastFireAt = new Map<string, number>();

  function getCount(ruleName: string, windowMs: number): number {
    const timestamps = counters.get(ruleName);
    if (timestamps === undefined) return 0;
    const threshold = now() - windowMs;
    const startIdx = lowerBound(timestamps, threshold);
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

  function evaluateRule(
    rule: CompiledRule,
    event: RuleEvent,
    actions: ResolvedAction[],
    skips: SkipDirective[],
  ): "stop" | "continue" {
    // Counter and dedupe state partitioned by `rule.name + toolId` for
    // tool_call events so a multi-tool rule does not let failures on
    // tool A trip the threshold for tool B.
    const counterKey = counterKeyFor(rule.name, event);

    // let justified: dedupe state mutated only when condition met
    let fireActions = true;
    if (rule.condition !== undefined) {
      incrementCounter(counterKey);
      const count = getCount(counterKey, rule.condition.windowMs);
      if (count < rule.condition.count) return "continue";
      const lastFire = lastFireAt.get(counterKey);
      const tNow = now();
      if (lastFire !== undefined && tNow - lastFire < rule.condition.windowMs) {
        // Suppress side-effects but still emit skip directives so
        // continued matches refresh block expiry.
        fireActions = false;
      } else {
        lastFireAt.set(counterKey, tNow);
      }
    }

    const expiresAt = rule.condition !== undefined ? now() + rule.condition.windowMs : null;
    const safeFields = pickSafeFields(event.fields);
    const extraContext: Readonly<Record<string, unknown>> =
      rule.condition !== undefined
        ? {
            ...safeFields,
            ruleName: rule.name,
            count: getCount(counterKey, rule.condition.windowMs),
            window: rule.condition.window,
            windowMs: rule.condition.windowMs,
            threshold: rule.condition.count,
          }
        : { ...safeFields, ruleName: rule.name };

    for (const action of rule.actions) {
      if (action.type === "skip_tool" && action.toolId !== undefined) {
        skips.push({ toolId: action.toolId, expiresAt });
        continue;
      }
      if (fireActions) {
        actions.push({ ruleName: rule.name, action, extraContext });
      }
    }
    return rule.stopOnMatch ? "stop" : "continue";
  }

  function evaluate(event: RuleEvent): RuleEvalResult {
    const rules = ruleset.byEventType.get(event.type);
    if (rules === undefined) return { actions: [], skips: [] };
    const actions: ResolvedAction[] = [];
    const skips: SkipDirective[] = [];
    for (const rule of rules) {
      if (!matchesPredicate(rule, event.fields)) continue;
      if (evaluateRule(rule, event, actions, skips) === "stop") break;
    }
    return { actions, skips };
  }

  function peekRule(event: RuleEvent): RuleEvalResult {
    const rules = ruleset.byEventType.get(event.type);
    if (rules === undefined) return { actions: [], skips: [] };
    const actions: ResolvedAction[] = [];
    const skips: SkipDirective[] = [];
    const currentToolId = event.fields.toolId;
    for (const rule of rules) {
      // Pre-call peek only honors unconditional rules; windowed rules must
      // observe the post-call event to update their counter, and their
      // skip directives are emitted at threshold-fire time in `evaluate`.
      if (rule.condition !== undefined) continue;
      // Only fire pre-call when this rule contains a skip_tool targeting
      // the in-flight tool. Without this gate, sibling log/notify/escalate
      // actions on non-blocking rules would fire in BOTH the pre-call and
      // post-call paths — duplicating side effects on every invocation.
      // When the skip targets the in-flight tool, applySkips will cause
      // `isBlocked` to short-circuit `next(request)` and the post-call
      // evaluate path, so pre-call companions fire exactly once.
      const blocksThisCall = rule.actions.some(
        (a) => a.type === "skip_tool" && a.toolId !== undefined && a.toolId === currentToolId,
      );
      if (!blocksThisCall) continue;
      if (!matchesPredicate(rule, event.fields)) continue;
      const extraContext: Readonly<Record<string, unknown>> = { ruleName: rule.name };
      for (const action of rule.actions) {
        if (action.type === "skip_tool" && action.toolId !== undefined) {
          skips.push({ toolId: action.toolId, expiresAt: null });
          continue;
        }
        actions.push({ ruleName: rule.name, action, extraContext });
      }
      if (rule.stopOnMatch) break;
    }
    return { actions, skips };
  }

  function reset(): void {
    counters.clear();
    lastFireAt.clear();
  }

  return { evaluate, peekRule, reset };
}
