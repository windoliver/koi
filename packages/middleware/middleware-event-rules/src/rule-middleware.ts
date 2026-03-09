/**
 * Event rules middleware — declarative event→action mapping.
 *
 * Hooks into session lifecycle, turn completion, and tool calls to evaluate
 * rules and execute actions. Session-scoped engine instances with in-memory
 * counter state.
 *
 * Priority 750: observe phase, runs after most business-logic middleware.
 */

import type { SessionId } from "@koi/core/ecs";
import type {
  CapabilityFragment,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { executeActions } from "./actions.js";
import { createRuleEngine } from "./rule-engine.js";
import type { ActionContext, EventRulesConfig, RuleEngine, RuleEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an event-rules middleware from a compiled ruleset.
 *
 * @param config - Compiled ruleset + optional action context + clock.
 */
export function createEventRulesMiddleware(config: EventRulesConfig): KoiMiddleware {
  const { ruleset, actionContext = {}, now = Date.now } = config;

  /** Session-scoped engine instances. */
  const engines = new Map<SessionId, RuleEngine>();

  /** Per-session set of tool IDs to skip (circuit-break). */
  const skipSets = new Map<SessionId, Set<string>>();

  function getOrCreateEngine(sessionId: SessionId): RuleEngine {
    const existing = engines.get(sessionId);
    if (existing !== undefined) return existing;
    const engine = createRuleEngine(ruleset, now);
    engines.set(sessionId, engine);
    return engine;
  }

  function getSkipSet(sessionId: SessionId): Set<string> {
    const existing = skipSets.get(sessionId);
    if (existing !== undefined) return existing;
    const skipSet = new Set<string>();
    skipSets.set(sessionId, skipSet);
    return skipSet;
  }

  async function evaluateAndExecute(
    event: RuleEvent,
    ctx: ActionContext,
  ): Promise<readonly string[]> {
    const engine = getOrCreateEngine(event.sessionId);
    const result = engine.evaluate(event);

    if (result.actions.length > 0) {
      await executeActions(result.actions, event.fields, ctx);
    }

    return result.skipToolIds;
  }

  const capabilityFragment: CapabilityFragment = {
    label: "event-rules",
    description: `Declarative event rules: ${ruleset.rules.length} rule(s) loaded`,
  };

  return {
    name: "koi:event-rules",
    priority: 750,
    phase: "observe",

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId;
      getOrCreateEngine(sessionId);

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

      await evaluateAndExecute(event, actionContext);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId;

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

      await evaluateAndExecute(event, actionContext);

      // Clean up session state
      const engine = engines.get(sessionId);
      if (engine !== undefined) {
        engine.reset();
        engines.delete(sessionId);
      }
      skipSets.delete(sessionId);
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
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

      await evaluateAndExecute(event, actionContext);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId;
      const skipSet = getSkipSet(sessionId);

      // Check if tool is circuit-broken
      if (skipSet.has(request.toolId)) {
        return {
          output: `Tool '${request.toolId}' is blocked by event rules`,
          metadata: { blocked: true, error: true },
        };
      }

      // Execute tool — wrap in try/catch so failure-driven rules still fire
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (error: unknown) {
        // Emit failure event so escalation / circuit-break rules can react
        const event: RuleEvent = {
          type: "tool_call",
          sessionId,
          fields: {
            ...flattenInput(request.input),
            toolId: request.toolId,
            ok: false,
          },
        };
        const newSkipIds = await evaluateAndExecute(event, actionContext);
        for (const toolId of newSkipIds) {
          skipSet.add(toolId);
        }
        throw error;
      }

      // Build event with ok derived from metadata
      const ok = !(response.metadata?.error === true);
      const event: RuleEvent = {
        type: "tool_call",
        sessionId,
        fields: {
          ...flattenInput(request.input),
          toolId: request.toolId,
          ok,
        },
      };

      // Evaluate rules and update skip set
      const newSkipIds = await evaluateAndExecute(event, actionContext);
      for (const toolId of newSkipIds) {
        skipSet.add(toolId);
      }

      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flattens input object for match field access.
 * Only includes primitive values (string, number, boolean) from top level.
 */
function flattenInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      flat[key] = value;
    }
  }
  return flat;
}
