/**
 * @koi/middleware-event-rules — type definitions.
 *
 * YAML rule schema, compiled runtime types, action context,
 * evaluation result types.
 */

import type { SessionId } from "@koi/core";

/** Rule-local event vocabulary, decoupled from EngineEvent. */
export type RuleEventType = "tool_call" | "turn_complete" | "session_start" | "session_end";

export interface RegexOperator {
  readonly regex: string;
}

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

export type MatchPredicates = Readonly<Record<string, MatchValue>>;

export type ActionType = "emit" | "escalate" | "log" | "notify" | "skip_tool";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface RawAction {
  readonly type: ActionType;
  readonly event?: string;
  readonly message?: string;
  readonly channel?: string;
  readonly level?: LogLevel;
  readonly toolId?: string;
}

export interface RawCondition {
  readonly count: number;
  readonly window: string;
}

export interface RawRule {
  readonly name: string;
  readonly on: RuleEventType;
  readonly match?: MatchPredicates;
  readonly condition?: RawCondition;
  readonly actions: readonly RawAction[];
  readonly stopOnMatch?: boolean;
}

export interface RawEventRulesConfig {
  readonly rules: readonly RawRule[];
}

export interface CompiledPredicate {
  readonly field: string;
  readonly test: (value: unknown) => boolean;
}

export interface CompiledRule {
  readonly name: string;
  readonly on: RuleEventType;
  readonly predicates: readonly CompiledPredicate[];
  readonly condition:
    | { readonly count: number; readonly window: string; readonly windowMs: number }
    | undefined;
  readonly actions: readonly RawAction[];
  readonly stopOnMatch: boolean;
}

export interface CompiledRuleset {
  readonly rules: readonly CompiledRule[];
  readonly byEventType: ReadonlyMap<RuleEventType, readonly CompiledRule[]>;
}

export interface RuleEvent {
  readonly type: RuleEventType;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly sessionId: SessionId;
}

export interface ResolvedAction {
  readonly ruleName: string;
  readonly action: RawAction;
  /**
   * Per-action extra fields merged into the interpolation context when
   * the action message is rendered. Engines populate this with rule-
   * specific metadata that is not on the raw event — most importantly
   * `count` (observed count when threshold fired) and `window` (raw
   * duration string) and `ruleName`, so alert templates can render
   * `{{count}}`/`{{window}}`/`{{ruleName}}`.
   */
  readonly extraContext?: Readonly<Record<string, unknown>>;
}

/**
 * Tool-skip directive emitted by a triggered `skip_tool` action.
 * `expiresAt` is the absolute epoch-ms expiry derived from the matching
 * rule's `condition.window` (or `null` if the rule has no window — i.e.
 * a permanent session-level block).
 */
export interface SkipDirective {
  readonly toolId: string;
  readonly expiresAt: number | null;
}

export interface RuleEvalResult {
  readonly actions: readonly ResolvedAction[];
  readonly skips: readonly SkipDirective[];
}

export interface RuleLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly debug: (message: string) => void;
}

export interface ActionContext {
  readonly logger?: RuleLogger;
  /**
   * Auxiliary action handlers (`emitEvent`, `requestEscalation`,
   * `sendNotification`, `onBlock`) receive an `AbortSignal` whose
   * `abort()` is called when the per-handler timeout (5s) fires.
   * Handlers are not required to honor it — JS cannot forcibly cancel
   * a Promise — but those that do (e.g. `fetch`, AbortSignal-aware
   * HTTP clients) can drop in-flight requests on timeout to prevent
   * orphaned sockets from accumulating during alerting outages.
   */
  readonly emitEvent?: (event: string, data: unknown, signal?: AbortSignal) => void | Promise<void>;
  readonly requestEscalation?: (message: string, signal?: AbortSignal) => void | Promise<void>;
  readonly sendNotification?: (
    channel: string,
    message: string,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  /**
   * Called whenever this middleware short-circuits a tool call by
   * returning a blocked response. Hosts can wire this into their
   * audit / event-trace / report pipelines so denials issued by the
   * outermost intercept wrapper still hit the normal recording path,
   * which would otherwise be skipped because observe-tier wrappers
   * never see calls that were short-circuited above them.
   *
   * Bounded by the same 5s per-handler timeout as auxiliary action
   * handlers (see `emitEvent` notes). The deny path NEVER blocks on
   * `onBlock` longer than the timeout — a slow audit hook cannot
   * stall every blocked retry of the tool.
   */
  readonly onBlock?: (
    info: {
      readonly toolId: string;
      readonly sessionId: string;
      readonly reason: "event_rules_skip";
    },
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface RuleEngine {
  readonly evaluate: (event: RuleEvent) => RuleEvalResult;
  /**
   * Pre-call peek for `tool_call` events: returns matched actions and
   * skip directives from unconditional rules without incrementing
   * counters. Lets the host block a tool invocation declaratively while
   * still firing companion observability actions (log/notify/escalate)
   * that the same rule attached to the block.
   */
  readonly peekRule: (event: RuleEvent) => RuleEvalResult;
  readonly reset: () => void;
}

export interface EventRulesConfig {
  readonly ruleset: CompiledRuleset;
  readonly actionContext?: ActionContext;
  readonly now?: () => number;
  /**
   * When `true`, the factory throws at construction time if any rule uses
   * a side-effecting action type (`escalate`, `notify`, `emit`) without
   * the corresponding handler wired in `actionContext`.
   * Defaults to `false` — missing handlers degrade to logging.
   * Set to `true` in production to fail closed instead of failing open
   * when an alerting/escalation pathway is mis-wired.
   */
  readonly strictActions?: boolean;
}
