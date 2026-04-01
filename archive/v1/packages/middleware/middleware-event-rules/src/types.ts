/**
 * Type definitions for @koi/middleware-event-rules.
 *
 * Covers the YAML rule schema, compiled runtime types,
 * action context, and evaluation results.
 */

import type { SessionId } from "@koi/core/ecs";

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Rule-local event vocabulary, decoupled from EngineEvent. */
export type RuleEventType = "tool_call" | "turn_complete" | "session_start" | "session_end";

// ---------------------------------------------------------------------------
// Match predicates (YAML input)
// ---------------------------------------------------------------------------

/** Regex match operator. */
export interface RegexOperator {
  readonly regex: string;
}

/** Numeric comparison operators. */
export interface NumericOperator {
  readonly gte?: number | undefined;
  readonly lte?: number | undefined;
  readonly gt?: number | undefined;
  readonly lt?: number | undefined;
}

/** A match value: primitive exact match, operator object, or array (oneOf). */
export type MatchValue =
  | string
  | number
  | boolean
  | RegexOperator
  | NumericOperator
  | readonly (string | number | boolean)[];

/** Match predicate object — flat key-value pairs. */
export type MatchPredicates = Readonly<Record<string, MatchValue>>;

// ---------------------------------------------------------------------------
// Actions (YAML input)
// ---------------------------------------------------------------------------

/** Built-in action types. */
export type ActionType = "emit" | "escalate" | "log" | "notify" | "skip_tool";

/** Log level for `log` action. */
export type LogLevel = "info" | "warn" | "error" | "debug";

/** Raw action as parsed from YAML. */
export interface RawAction {
  readonly type: ActionType;
  readonly event?: string;
  readonly message?: string;
  readonly channel?: string;
  readonly level?: LogLevel;
  readonly toolId?: string;
}

// ---------------------------------------------------------------------------
// Rule (YAML input)
// ---------------------------------------------------------------------------

/** Windowed counter condition. */
export interface RawCondition {
  readonly count: number;
  readonly window: string;
}

/** A single rule as parsed from YAML. */
export interface RawRule {
  readonly name: string;
  readonly on: RuleEventType;
  readonly match?: MatchPredicates;
  readonly condition?: RawCondition;
  readonly actions: readonly RawAction[];
  readonly stopOnMatch?: boolean;
}

/** Top-level YAML config. */
export interface RawEventRulesConfig {
  readonly rules: readonly RawRule[];
}

// ---------------------------------------------------------------------------
// Compiled runtime types
// ---------------------------------------------------------------------------

/** A compiled predicate: field name + test closure. */
export interface CompiledPredicate {
  readonly field: string;
  readonly test: (value: unknown) => boolean;
}

/** A compiled rule with parsed window, compiled predicates, and indexed position. */
export interface CompiledRule {
  readonly name: string;
  readonly on: RuleEventType;
  readonly predicates: readonly CompiledPredicate[];
  readonly condition: { readonly count: number; readonly windowMs: number } | undefined;
  readonly actions: readonly RawAction[];
  readonly stopOnMatch: boolean;
}

/** Immutable compiled ruleset with pre-indexed lookup by event type. */
export interface CompiledRuleset {
  readonly rules: readonly CompiledRule[];
  readonly byEventType: ReadonlyMap<RuleEventType, readonly CompiledRule[]>;
}

// ---------------------------------------------------------------------------
// Runtime event + evaluation result
// ---------------------------------------------------------------------------

/** An event emitted to the rule engine for evaluation. */
export interface RuleEvent {
  readonly type: RuleEventType;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly sessionId: SessionId;
}

/** Result of evaluating rules against an event. */
export interface RuleEvalResult {
  /** Actions to execute. */
  readonly actions: readonly ResolvedAction[];
  /** Tool IDs to skip (from skip_tool actions). */
  readonly skipToolIds: readonly string[];
}

/** An action resolved with its originating rule name and event context. */
export interface ResolvedAction {
  readonly ruleName: string;
  readonly action: RawAction;
}

// ---------------------------------------------------------------------------
// Action context — injected dependencies for action execution
// ---------------------------------------------------------------------------

/** Logger interface for rule actions. */
export interface RuleLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly debug: (message: string) => void;
}

/** Dependencies injected into action execution. */
export interface ActionContext {
  readonly logger?: RuleLogger;
  readonly emitEvent?: (event: string, data: unknown) => void | Promise<void>;
  readonly requestEscalation?: (message: string) => void | Promise<void>;
  readonly sendNotification?: (channel: string, message: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

/** A rule engine instance scoped to a single session. */
export interface RuleEngine {
  /** Evaluate an event against the ruleset and return matched actions. */
  readonly evaluate: (event: RuleEvent) => RuleEvalResult;
  /** Clear all counter state. */
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Config for factory
// ---------------------------------------------------------------------------

/** Configuration for createEventRulesMiddleware. */
export interface EventRulesConfig {
  /** Compiled ruleset (already validated). */
  readonly ruleset: CompiledRuleset;
  /** Action context dependencies. */
  readonly actionContext?: ActionContext;
  /** Injectable clock for testing. Default: Date.now. */
  readonly now?: () => number;
}
