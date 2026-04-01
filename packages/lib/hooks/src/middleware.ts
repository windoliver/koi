/**
 * Hook middleware — bridges @koi/hooks execution into the KoiMiddleware contract.
 *
 * Maps engine lifecycle events to hook dispatch:
 *   onSessionStart  → "session.started"
 *   onSessionEnd    → "session.ended"
 *   onBeforeTurn    → "turn.started"
 *   onAfterTurn     → "turn.ended"
 *   wrapToolCall    → "tool.pre" (blocking) + "tool.post" (fire-and-forget)
 *   wrapModelCall   → "model.pre" (blocking) + "model.post" (fire-and-forget)
 *
 * Pre-call hooks block and aggregate decisions (block > modify > continue).
 * Post-call hooks fire-and-forget — errors are silently swallowed.
 *
 * Phase: "resolve" (priority 400). Hooks are business logic, not permissions.
 */

import type {
  CapabilityFragment,
  HookConfig,
  HookDecision,
  HookEvent,
  HookExecutionResult,
  JsonObject,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createHookRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Options for creating a hook middleware. */
export interface CreateHookMiddlewareOptions {
  /** Validated hook configs to dispatch. Typically from `loadHooks()`. */
  readonly hooks: readonly HookConfig[];
}

// ---------------------------------------------------------------------------
// Decision aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate hook decisions with most-restrictive-wins precedence:
 *   block > modify > continue
 *
 * - First `block` wins immediately (short-circuits).
 * - Multiple `modify` patches are merged (later patches override earlier keys).
 * - Failed hooks (ok: false) are treated as no opinion (fail-open).
 */
export function aggregateDecisions(results: readonly HookExecutionResult[]): HookDecision {
  let hasModify = false;
  let mergedPatch: JsonObject = {};

  for (const result of results) {
    if (!result.ok) continue;

    switch (result.decision.kind) {
      case "block":
        return result.decision;
      case "modify":
        hasModify = true;
        mergedPatch = { ...mergedPatch, ...result.decision.patch };
        break;
      case "continue":
        break;
    }
  }

  if (hasModify) {
    return { kind: "modify", patch: mergedPatch };
  }

  return { kind: "continue" };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates a KoiMiddleware that dispatches hook definitions to command/http
 * executors during the engine lifecycle.
 *
 * @param options - Hook configs to register per session.
 * @returns A KoiMiddleware at resolve phase, priority 400.
 */
export function createHookMiddleware(options: CreateHookMiddlewareOptions): KoiMiddleware {
  const { hooks } = options;
  const registry = createHookRegistry();

  function buildEvent(
    ctx: SessionContext,
    event: string,
    extra?: { readonly toolName?: string; readonly data?: JsonObject },
  ): HookEvent {
    return {
      event,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId as string,
      ...(extra?.toolName !== undefined ? { toolName: extra.toolName } : {}),
      ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
    };
  }

  /** Fire hooks and swallow errors — for fire-and-forget post-call dispatch. */
  function fireAndForget(sessionId: string, event: HookEvent): void {
    void registry.execute(sessionId, event).catch(() => {
      /* post-call hooks are observational — errors silently swallowed */
    });
  }

  return {
    name: "hooks",
    phase: "resolve",
    priority: 400,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      registry.register(sessionId, ctx.agentId, hooks);
      const event = buildEvent(ctx, "session.started");
      await registry.execute(sessionId, event);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      const event = buildEvent(ctx, "session.ended");
      await registry.execute(sessionId, event);
      registry.cleanup(sessionId);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.started");
      await registry.execute(sessionId, event);
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.ended");
      // After-turn hooks are fire-and-forget — don't block the engine
      fireAndForget(sessionId, event);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId as string;

      // Pre-call: blocking dispatch with decision aggregation
      const preEvent = buildEvent(ctx.session, "tool.pre", {
        toolName: request.toolId,
        data: { input: request.input } as JsonObject,
      });
      const preResults = await registry.execute(sessionId, preEvent);
      const decision = aggregateDecisions(preResults);

      if (decision.kind === "block") {
        return {
          output: { error: `Blocked by hook: ${decision.reason}` },
          metadata: { blockedByHook: true },
        };
      }

      const effectiveRequest: ToolRequest =
        decision.kind === "modify"
          ? { ...request, input: { ...request.input, ...decision.patch } }
          : request;

      const response = await next(effectiveRequest);

      // Post-call: fire-and-forget
      const postEvent = buildEvent(ctx.session, "tool.post", {
        toolName: request.toolId,
        data: { input: request.input, output: response.output } as JsonObject,
      });
      fireAndForget(sessionId, postEvent);

      return response;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId as string;

      // Pre-call: blocking dispatch with decision aggregation
      const preEvent = buildEvent(ctx.session, "model.pre", {
        data: { model: request.model ?? "default" } as JsonObject,
      });
      const preResults = await registry.execute(sessionId, preEvent);
      const decision = aggregateDecisions(preResults);

      if (decision.kind === "block") {
        return {
          content: `[Hook blocked model call: ${decision.reason}]`,
          model: request.model ?? "unknown",
          metadata: { blockedByHook: true },
        };
      }

      const effectiveRequest: ModelRequest =
        decision.kind === "modify"
          ? { ...request, metadata: { ...request.metadata, ...decision.patch } }
          : request;

      const response = await next(effectiveRequest);

      // Post-call: fire-and-forget
      const postEvent = buildEvent(ctx.session, "model.post", {
        data: { model: response.model } as JsonObject,
      });
      fireAndForget(sessionId, postEvent);

      return response;
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (hooks.length === 0) return undefined;
      const names = hooks.map((h) => h.name).join(", ");
      return {
        label: "hooks",
        description: `Active hooks: ${names}`,
      };
    },
  };
}
