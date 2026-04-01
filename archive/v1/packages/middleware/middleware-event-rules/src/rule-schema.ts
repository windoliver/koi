/**
 * Zod schema + compilation for event rule configs.
 *
 * Validates YAML input exhaustively at load time, compiles regex patterns
 * into closures, parses duration strings, and pre-indexes rules by event type.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { parseDuration } from "./duration.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_TYPES: readonly RuleEventType[] = [
  "tool_call",
  "turn_complete",
  "session_start",
  "session_end",
] as const;

const ACTION_TYPES = ["emit", "escalate", "log", "notify", "skip_tool"] as const;
const LOG_LEVELS = ["info", "warn", "error", "debug"] as const;

// ---------------------------------------------------------------------------
// Match value schemas
// ---------------------------------------------------------------------------

const regexOperatorSchema = z.object({
  regex: z
    .string()
    .min(1)
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
    ),
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
    {
      message: "Numeric operator must have at least one of gte, lte, gt, lt",
    },
  );

const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const oneOfSchema = z.array(primitiveSchema).min(1);

const matchValueSchema = z.union([
  primitiveSchema,
  regexOperatorSchema,
  numericOperatorSchema,
  oneOfSchema,
]);

// ---------------------------------------------------------------------------
// Action schema
// ---------------------------------------------------------------------------

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
    {
      message: "Action is missing required fields for its type",
    },
  );

// ---------------------------------------------------------------------------
// Condition schema
// ---------------------------------------------------------------------------

const conditionSchema = z.object({
  count: z.number().int().min(1),
  window: z.string().refine((w) => parseDuration(w) !== undefined, {
    message: "Invalid duration format — use s/m/h (e.g., '30s', '5m', '1h')",
  }),
});

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

const ruleSchema = z.object({
  name: z.string().min(1),
  on: z.enum(EVENT_TYPES as unknown as [string, ...string[]]),
  match: z.record(z.string(), matchValueSchema).optional(),
  condition: conditionSchema.optional(),
  actions: z.array(actionSchema).min(1),
  stopOnMatch: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Top-level config schema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function isRegexOperator(v: unknown): v is RegexOperator {
  return typeof v === "object" && v !== null && "regex" in v;
}

function isNumericOperator(v: unknown): v is NumericOperator {
  if (typeof v !== "object" || v === null) return false;
  return "gte" in v || "lte" in v || "gt" in v || "lt" in v;
}

function compilePredicate(field: string, value: MatchValue): CompiledPredicate {
  // Array → oneOf
  if (Array.isArray(value)) {
    const allowed = new Set(value.map(String));
    return { field, test: (v: unknown) => allowed.has(String(v)) };
  }

  // Regex operator
  if (isRegexOperator(value)) {
    const re = new RegExp(value.regex);
    return { field, test: (v: unknown) => typeof v === "string" && re.test(v) };
  }

  // Numeric operator
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

  // Primitive exact match
  return { field, test: (v: unknown) => v === value };
}

function compileRule(raw: RawRule): CompiledRule {
  const predicates: readonly CompiledPredicate[] = raw.match
    ? Object.entries(raw.match).map(([field, value]) => compilePredicate(field, value))
    : [];

  // Window is validated by Zod refine — parseDuration is guaranteed non-undefined here
  const condition = raw.condition
    ? { count: raw.condition.count, windowMs: parseDuration(raw.condition.window) ?? 0 }
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates and compiles an event rules config from unknown input.
 *
 * Performs exhaustive validation (Zod), compiles regex into closures,
 * parses durations, and pre-indexes rules by event type.
 */
export function validateEventRulesConfig(input: unknown): Result<CompiledRuleset, KoiError> {
  const result = validateWith(
    eventRulesConfigSchema,
    input,
    "Event rules config validation failed",
  );
  if (!result.ok) return result;
  return { ok: true, value: compileRuleset(result.value as RawEventRulesConfig) };
}
