/**
 * Zod schema + compilation for event rule configs.
 *
 * Validates input exhaustively at load time, compiles regex patterns
 * into closures, parses durations, and pre-indexes rules by event type.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { parseDuration } from "./duration.js";
import { isSkipToolRuleValid, unknownMatchFieldsFor } from "./match-validators.js";
import { MAX_COUNTER_ENTRIES } from "./rule-engine.js";
import type {
  CompiledPredicate,
  CompiledRule,
  CompiledRuleset,
  MatchValue,
  NumericOperator,
  RawEventRulesConfig,
  RawRule,
  RegexOperator,
  RuleEventType,
} from "./types.js";

const EVENT_TYPES = ["tool_call", "turn_complete", "session_start", "session_end"] as const;
const ACTION_TYPES = ["emit", "escalate", "log", "notify", "skip_tool"] as const;
const LOG_LEVELS = ["info", "warn", "error", "debug"] as const;

/** Cap on regex pattern length to bound compile/test cost. */
export const MAX_REGEX_PATTERN_LENGTH = 256;
/** Cap on input length passed to a regex predicate test. */
export const MAX_REGEX_INPUT_LENGTH = 4096;

/**
 * Heuristic catastrophic-backtracking detector. Flags patterns that
 * combine nested quantifiers (`(a+)+`, `(a*)*`), alternation with
 * shared prefixes inside a quantifier (`(a|a)*`, `(a|ab)+`), or
 * unbounded repetition of a group containing alternation/repetition.
 * Not exhaustive — JS regex engines have many ReDoS shapes — but it
 * catches the common cases without pulling in a parser.
 */
function looksRedosProne(pattern: string): boolean {
  // Nested quantifier: another quantifier adjacent inside a group.
  // Examples caught: (a+)+, (a*)*, (a+)*, (.*)+
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return true;
  // Quantifier on a group with internal alternation having common-
  // prefix overlap is hard to detect cheaply; reject any quantifier
  // applied to a `|` group (over-cautious but safe). Examples
  // caught: (a|a)*, (foo|fo)+, (.|.)*.
  if (/\([^()]*\|[^()]*\)[+*]/.test(pattern)) return true;
  return false;
}

const regexOperatorSchema = z.object({
  regex: z
    .string()
    .min(1)
    .max(MAX_REGEX_PATTERN_LENGTH)
    .refine(
      (pattern) => {
        try {
          new RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid regular expression" },
    )
    .refine((pattern) => !looksRedosProne(pattern), {
      message:
        "Pattern looks vulnerable to catastrophic backtracking (nested quantifiers / alternation with quantifier). " +
        "Rewrite to avoid `(a+)+` / `(a|a)*` shapes, or use a more specific anchor.",
    }),
});

const numericOperatorSchema = z
  .object({
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .refine(
    (o) => o.gte !== undefined || o.lte !== undefined || o.gt !== undefined || o.lt !== undefined,
    { message: "Numeric operator must have at least one of gte, lte, gt, lt" },
  );

const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const oneOfSchema = z.array(primitiveSchema).min(1);

const matchValueSchema = z.union([
  primitiveSchema,
  regexOperatorSchema,
  numericOperatorSchema,
  oneOfSchema,
]);

const actionSchema = z
  .object({
    type: z.enum(ACTION_TYPES),
    event: z.string().optional(),
    message: z.string().optional(),
    channel: z.string().optional(),
    level: z.enum(LOG_LEVELS).optional(),
    toolId: z.string().optional(),
  })
  .refine(
    (a) => {
      switch (a.type) {
        case "emit":
          return a.event !== undefined;
        case "escalate":
          return a.message !== undefined;
        case "log":
          return a.level !== undefined && a.message !== undefined;
        case "notify":
          return a.channel !== undefined && a.message !== undefined;
        case "skip_tool":
          return a.toolId !== undefined;
        default:
          return true;
      }
    },
    { message: "Action is missing required fields for its type" },
  );

const conditionSchema = z.object({
  // Cap aligned with the rule engine's per-rule counter capacity. Higher
  // thresholds are unreachable because the counter drops oldest entries past
  // 1000, so they would silently never fire.
  count: z.number().int().min(1).max(MAX_COUNTER_ENTRIES),
  window: z.string().refine((w) => parseDuration(w) !== undefined, {
    message: "Invalid duration format — use s/m/h (e.g., '30s', '5m', '1h')",
  }),
});

/**
 * Allowed `match` keys per event type. Rejecting unknown keys at validation
 * time prevents typos like `toolID` (instead of `toolId`) from compiling
 * into a permanent dead-rule that silently fails open.
 *
 * `tool_call` allows arbitrary additional keys because flattened input
 * fields (untyped, tool-specific) are exposed alongside the core context
 * fields, and the validator cannot enumerate every possible tool's input.
 */
/* Field-allowlist, Damerau-Levenshtein-1 typo guard, and skip_tool
 * rule validation live in `match-validators.ts` (imported above). */

const ruleSchema = z
  .object({
    name: z.string().min(1),
    on: z.enum(EVENT_TYPES),
    match: z.record(z.string(), matchValueSchema).optional(),
    condition: conditionSchema.optional(),
    actions: z.array(actionSchema).min(1),
    stopOnMatch: z.boolean().optional(),
  })
  .refine((r) => r.match === undefined || unknownMatchFieldsFor(r.on, r.match).length === 0, {
    message:
      "Rule has match field(s) that do not exist on its event type — typos like 'toolID' would silently fail open. Allowed: tool_call (open), turn_complete (turnIndex/agentId/sessionId), session_*  (agentId/sessionId/userId/channelId).",
  })
  .refine((r) => isSkipToolRuleValid(r), {
    message:
      "skip_tool rules on tool_call may only match on tool-level fields (toolId/ok/blocked/blockedByHook/reason). " +
      "Narrower-than-toolId predicates (input fields, agentId, sessionId, turnIndex) are rejected because the " +
      "block is stored by toolId alone — a one-shot match would otherwise silently turn into a session-wide ban. " +
      "For input-scoped denial use a non-skip_tool action (log/notify/escalate), or use a host-side guard.",
  });

const eventRulesConfigSchema = z
  .object({
    rules: z.array(ruleSchema).min(1),
  })
  .refine(
    (cfg) => {
      const names = cfg.rules.map((r) => r.name);
      return new Set(names).size === names.length;
    },
    { message: "Rule names must be unique" },
  );

function isRegexOperator(v: unknown): v is RegexOperator {
  return typeof v === "object" && v !== null && "regex" in v;
}

function isNumericOperator(v: unknown): v is NumericOperator {
  if (typeof v !== "object" || v === null) return false;
  return "gte" in v || "lte" in v || "gt" in v || "lt" in v;
}

function compilePredicate(field: string, value: MatchValue): CompiledPredicate {
  if (Array.isArray(value)) {
    // Type-preserving membership test — `1` must not match `"1"`, `true`
    // must not match `"true"`. Set.has uses SameValueZero so primitives
    // are compared by value with strict-equality semantics.
    const allowed = new Set<unknown>(value);
    return { field, test: (v: unknown) => allowed.has(v) };
  }
  if (isRegexOperator(value)) {
    const re = new RegExp(value.regex);
    return {
      field,
      test: (v: unknown) => {
        if (typeof v !== "string") return false;
        // Bound input length on the hot path so an attacker-controlled
        // input field can't combine with a complex (but not flagged)
        // pattern to produce excessive scan time. 4096 covers normal
        // tool-arg strings; longer inputs are silently truncated for
        // matching purposes only (the predicate is observability/
        // policy, not data-handling).
        const sample = v.length > MAX_REGEX_INPUT_LENGTH ? v.slice(0, MAX_REGEX_INPUT_LENGTH) : v;
        return re.test(sample);
      },
    };
  }
  if (isNumericOperator(value)) {
    return {
      field,
      test: (v: unknown) => {
        if (typeof v !== "number") return false;
        if (value.gte !== undefined && v < value.gte) return false;
        if (value.lte !== undefined && v > value.lte) return false;
        if (value.gt !== undefined && v <= value.gt) return false;
        if (value.lt !== undefined && v >= value.lt) return false;
        return true;
      },
    };
  }
  return { field, test: (v: unknown) => v === value };
}

function compileRule(raw: RawRule): CompiledRule {
  const predicates: readonly CompiledPredicate[] = raw.match
    ? Object.entries(raw.match).map(([field, value]) => compilePredicate(field, value))
    : [];

  const condition = raw.condition
    ? {
        count: raw.condition.count,
        window: raw.condition.window,
        windowMs: parseDuration(raw.condition.window) ?? 0,
      }
    : undefined;

  return {
    name: raw.name,
    on: raw.on,
    predicates,
    condition,
    actions: raw.actions,
    stopOnMatch: raw.stopOnMatch ?? false,
  };
}

function compileRuleset(raw: RawEventRulesConfig): CompiledRuleset {
  const rules = raw.rules.map(compileRule);
  const byEventType = new Map<RuleEventType, CompiledRule[]>();
  for (const rule of rules) {
    const existing = byEventType.get(rule.on);
    if (existing !== undefined) {
      byEventType.set(rule.on, [...existing, rule]);
    } else {
      byEventType.set(rule.on, [rule]);
    }
  }
  return { rules, byEventType };
}

export function validateEventRulesConfig(input: unknown): Result<CompiledRuleset, KoiError> {
  const result = validateWith(
    eventRulesConfigSchema,
    input,
    "Event rules config validation failed",
  );
  if (!result.ok) return result;
  return { ok: true, value: compileRuleset(result.value as RawEventRulesConfig) };
}
