/**
 * @koi/middleware-event-rules — Declarative event→action rule engine.
 *
 * Maps engine events (tool calls, turn completion, session lifecycle) to
 * actions (escalate, notify, log, skip_tool) via YAML rules. No custom
 * middleware code needed for common reaction patterns.
 */

export { executeActions } from "./actions.js";
export { parseDuration } from "./duration.js";
export { interpolate } from "./interpolate.js";
export { loadRulesFromFile, loadRulesFromString } from "./load-rules.js";
export { createRuleEngine } from "./rule-engine.js";
export { createEventRulesMiddleware } from "./rule-middleware.js";
export { validateEventRulesConfig } from "./rule-schema.js";
export type {
  ActionContext,
  ActionType,
  CompiledPredicate,
  CompiledRule,
  CompiledRuleset,
  EventRulesConfig,
  LogLevel,
  MatchPredicates,
  MatchValue,
  NumericOperator,
  RawAction,
  RawCondition,
  RawEventRulesConfig,
  RawRule,
  RegexOperator,
  ResolvedAction,
  RuleEngine,
  RuleEvalResult,
  RuleEvent,
  RuleEventType,
  RuleLogger,
} from "./types.js";
