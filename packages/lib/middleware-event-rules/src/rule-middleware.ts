/**
 * Event rules middleware — declarative event→action mapping.
 *
 * Hooks into session lifecycle, turn completion, and tool calls to evaluate
 * rules and execute actions. Session-scoped engine instances with in-memory
 * counter state.
 *
 * Phase: `intercept`, priority `50` — runs as the OUTERMOST tool-call
 * wrapper so blocked/denied responses from inner middleware (permissions,
 * call-limits, hooks, etc.) flow back through this layer and reach the
 * rule engine's failure-classification path. Without this, an
 * `intercept`-phase block (e.g. permissions deny) would never be observed
 * by `match: { ok: false }` rules and alerting would silently fail open.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  SessionContext,
  SessionId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { executeActions } from "./actions.js";
import { findMissingActionHandlers } from "./helpers.js";
import { createRuleEngine } from "./rule-engine.js";
import type { ActionContext, EventRulesConfig, RuleEngine, RuleEvent } from "./types.js";
import { createWrapToolCall } from "./wrap-tool-call.js";

export interface MiddlewareState {
  readonly engines: Map<SessionId, RuleEngine>;
  readonly skipSets: Map<SessionId, Map<string, number | null>>;
  readonly pendingActions: Map<SessionId, Set<Promise<void>>>;
  readonly closedSessions: Set<SessionId>;
  readonly generations: Map<SessionId, number>;
  readonly ruleset: EventRulesConfig["ruleset"];
  readonly actionContext: ActionContext;
  readonly now: () => number;
  getOrCreateEngine(sessionId: SessionId): RuleEngine;
  getSkipSet(sessionId: SessionId): Map<string, number | null>;
  isBlocked(skipSet: Map<string, number | null>, toolId: string): boolean;
  applySkips(
    skipSet: Map<string, number | null>,
    skips: ReturnType<RuleEngine["evaluate"]>["skips"],
  ): void;
  evaluateAndExecute(
    event: RuleEvent,
    ctx: ActionContext,
    skipSet: Map<string, number | null>,
  ): void;
  trackPending(sessionId: SessionId, pending: Promise<void>): void;
}

function getOrCreateEngine(state: MiddlewareState, sessionId: SessionId): RuleEngine {
  const existing = state.engines.get(sessionId);
  if (existing !== undefined) return existing;
  const engine = createRuleEngine(state.ruleset, state.now);
  state.engines.set(sessionId, engine);
  return engine;
}

function getSkipSet(state: MiddlewareState, sessionId: SessionId): Map<string, number | null> {
  const existing = state.skipSets.get(sessionId);
  if (existing !== undefined) return existing;
  const skipSet = new Map<string, number | null>();
  state.skipSets.set(sessionId, skipSet);
  return skipSet;
}

function isBlocked(
  state: MiddlewareState,
  skipSet: Map<string, number | null>,
  toolId: string,
): boolean {
  const expiresAt = skipSet.get(toolId);
  if (expiresAt === undefined) return false;
  if (expiresAt === null) return true;
  if (state.now() >= expiresAt) {
    skipSet.delete(toolId);
    return false;
  }
  return true;
}

function applySkips(
  skipSet: Map<string, number | null>,
  skips: ReturnType<RuleEngine["evaluate"]>["skips"],
): void {
  for (const { toolId, expiresAt } of skips) {
    const existing = skipSet.get(toolId);
    if (existing === null) continue;
    if (expiresAt === null) {
      skipSet.set(toolId, null);
      continue;
    }
    if (existing === undefined || existing < expiresAt) {
      skipSet.set(toolId, expiresAt);
    }
  }
}

function trackPending(state: MiddlewareState, sessionId: SessionId, pending: Promise<void>): void {
  const set = state.pendingActions.get(sessionId) ?? new Set<Promise<void>>();
  state.pendingActions.set(sessionId, set);
  set.add(pending);
  void pending.finally(() => {
    set.delete(pending);
  });
}

function evaluateAndExecute(
  state: MiddlewareState,
  event: RuleEvent,
  ctx: ActionContext,
  skipSet: Map<string, number | null>,
): void {
  if (state.closedSessions.has(event.sessionId)) return;
  const engine = getOrCreateEngine(state, event.sessionId);
  const result = engine.evaluate(event);
  applySkips(skipSet, result.skips);
  if (result.actions.length > 0) {
    trackPending(state, event.sessionId, executeActions(result.actions, event.fields, ctx));
  }
}

function createState(config: EventRulesConfig): MiddlewareState {
  const { ruleset, actionContext = {}, now = Date.now } = config;
  const state: MiddlewareState = {
    engines: new Map(),
    skipSets: new Map(),
    pendingActions: new Map(),
    closedSessions: new Set(),
    generations: new Map(),
    ruleset,
    actionContext,
    now,
    getOrCreateEngine: (sessionId): RuleEngine => getOrCreateEngine(state, sessionId),
    getSkipSet: (sessionId): Map<string, number | null> => getSkipSet(state, sessionId),
    isBlocked: (skipSet, toolId): boolean => isBlocked(state, skipSet, toolId),
    applySkips,
    evaluateAndExecute: (event, ctx, skipSet): void =>
      evaluateAndExecute(state, event, ctx, skipSet),
    trackPending: (sessionId, pending): void => trackPending(state, sessionId, pending),
  };
  return state;
}

async function handleSessionStart(state: MiddlewareState, ctx: SessionContext): Promise<void> {
  const sessionId = ctx.sessionId;
  // Clear any stale tombstone left from a prior session that happened to
  // use this ID (host reconnects, test reuse). Bump generation so a
  // racing onSessionEnd drain that was running for the prior session
  // can detect the reuse and skip teardown.
  state.closedSessions.delete(sessionId);
  state.generations.set(sessionId, (state.generations.get(sessionId) ?? 0) + 1);
  state.getOrCreateEngine(sessionId);
  const event: RuleEvent = {
    type: "session_start",
    sessionId,
    fields: {
      agentId: ctx.agentId,
      sessionId,
      userId: ctx.userId,
      channelId: ctx.channelId,
    },
  };
  state.evaluateAndExecute(event, state.actionContext, state.getSkipSet(sessionId));
}

async function handleSessionEnd(state: MiddlewareState, ctx: SessionContext): Promise<void> {
  const sessionId = ctx.sessionId;
  const generation = state.generations.get(sessionId) ?? 0;
  const event: RuleEvent = {
    type: "session_end",
    sessionId,
    fields: {
      agentId: ctx.agentId,
      sessionId,
      userId: ctx.userId,
      channelId: ctx.channelId,
    },
  };
  state.evaluateAndExecute(event, state.actionContext, state.getSkipSet(sessionId));
  // Mark CLOSED FIRST. Late tool calls awaiting `next()` could finish
  // during the drain below; without this fence their post-call
  // evaluateAndExecute would enqueue NEW pending work into a closing
  // session — those entries wouldn't be in the snapshot we await and
  // could fire after teardown completes.
  state.closedSessions.add(sessionId);
  const pending = state.pendingActions.get(sessionId);
  if (pending !== undefined && pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  // Reused-ID guard: if a fresh `onSessionStart` ran for the same
  // sessionId during the drain above, the generation will have
  // advanced. Skip teardown so the new session's state survives.
  const currentGeneration = state.generations.get(sessionId);
  if (currentGeneration !== generation) return;
  state.pendingActions.delete(sessionId);
  const engine = state.engines.get(sessionId);
  if (engine !== undefined) {
    engine.reset();
    state.engines.delete(sessionId);
  }
  state.skipSets.delete(sessionId);
  state.generations.delete(sessionId);
}

async function handleAfterTurn(state: MiddlewareState, ctx: TurnContext): Promise<void> {
  const sessionId = ctx.session.sessionId;
  const event: RuleEvent = {
    type: "turn_complete",
    sessionId,
    fields: {
      turnIndex: ctx.turnIndex,
      agentId: ctx.session.agentId,
      sessionId,
    },
  };
  state.evaluateAndExecute(event, state.actionContext, state.getSkipSet(sessionId));
}

export function createEventRulesMiddleware(config: EventRulesConfig): KoiMiddleware {
  const { strictActions = false, ruleset, actionContext = {} } = config;

  if (strictActions) {
    const missing = findMissingActionHandlers(ruleset, actionContext);
    if (missing.length > 0) {
      throw new Error(`[event-rules] strictActions=true rejected ruleset: ${missing.join("; ")}`);
    }
  }

  const state = createState(config);
  const wrapToolCall = createWrapToolCall(state);

  const capabilityFragment: CapabilityFragment = {
    label: "event-rules",
    description: `Declarative event rules: ${ruleset.rules.length} rule(s) loaded`,
  };

  return {
    name: "koi:event-rules",
    priority: 50,
    phase: "intercept",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    onSessionStart: (ctx: SessionContext): Promise<void> => handleSessionStart(state, ctx),
    onSessionEnd: (ctx: SessionContext): Promise<void> => handleSessionEnd(state, ctx),
    onAfterTurn: (ctx: TurnContext): Promise<void> => handleAfterTurn(state, ctx),
    wrapToolCall: (
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => wrapToolCall(ctx, request, next),
  };
}
