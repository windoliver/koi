/**
 * Hook middleware — bridges @koi/hooks execution into the KoiMiddleware contract.
 *
 * Maps engine lifecycle events to hook dispatch:
 *   onSessionStart  → "session.started" (blocking — throws on block decision)
 *   onSessionEnd    → "session.ended"   (awaited — block/modify ignored)
 *   onBeforeTurn    → "turn.started"    (blocking — throws on block decision)
 *   onAfterTurn     → "turn.ended"      (fire-and-forget, drained on session end)
 *   wrapToolCall    → "tool.before" (blocking) + "tool.succeeded" (fire-and-forget, drained)
 *   wrapModelCall   → "compact.before" (blocking) + "compact.after" (fire-and-forget, drained)
 *   wrapModelStream → "compact.before" (blocking) + "compact.after" (fire-and-forget, drained)
 *
 * Pre-call hooks block and aggregate decisions (block > modify > continue).
 * Post-call hooks are fire-and-forget during the turn but drained with a bounded
 * wait before session cleanup to prevent last-turn hooks from being aborted.
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
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
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

/** Result of aggregating hook decisions — includes the winning hook's identity. */
export interface AggregatedDecision {
  readonly decision: HookDecision;
  /** Name of the hook that produced the winning decision (set for block). */
  readonly hookName?: string;
}

/**
 * Aggregate hook decisions with most-restrictive-wins precedence:
 *   block > modify > continue
 *
 * - First `block` wins immediately (short-circuits).
 * - Multiple `modify` patches are merged (later patches override earlier keys).
 * - Failed hooks (ok: false) are treated as no opinion (fail-open).
 *
 * Returns the decision plus the winning hook's name (for block decisions).
 */
export function aggregateDecisions(results: readonly HookExecutionResult[]): AggregatedDecision {
  let hasModify = false;
  let mergedPatch: JsonObject = {};

  for (const result of results) {
    if (!result.ok) continue;

    switch (result.decision.kind) {
      case "block":
        return { decision: result.decision, hookName: result.hookName };
      case "modify":
        hasModify = true;
        mergedPatch = { ...mergedPatch, ...result.decision.patch };
        break;
      case "continue":
        break;
    }
  }

  if (hasModify) {
    return { decision: { kind: "modify", patch: mergedPatch } };
  }

  return { decision: { kind: "continue" } };
}

// ---------------------------------------------------------------------------
// Block message formatting
// ---------------------------------------------------------------------------

/** Format a consistent block message across all hook block paths. */
function formatBlockMessage(context: string, reason: string): string {
  return `Hook blocked ${context}: ${reason}`;
}

// ---------------------------------------------------------------------------
// Model request patch safety
// ---------------------------------------------------------------------------

/**
 * Fields that hooks are allowed to patch on ModelRequest via modify decisions.
 * Core control fields (messages, tools, systemPrompt, signal) are immutable
 * to prevent hook bugs from corrupting request shape or disabling safeguards.
 */
const MODEL_PATCH_ALLOWLIST = new Set<string>(["model", "temperature", "maxTokens", "metadata"]);

/**
 * Filter a modify patch to only include allowed ModelRequest fields.
 * Returns the filtered patch, or undefined if nothing remains after filtering.
 */
function filterModelPatch(patch: JsonObject): JsonObject | undefined {
  const filtered: Record<string, unknown> = {};
  let hasKeys = false;
  for (const key of Object.keys(patch)) {
    if (MODEL_PATCH_ALLOWLIST.has(key)) {
      filtered[key] = patch[key];
      hasKeys = true;
    }
  }
  return hasKeys ? (filtered as JsonObject) : undefined;
}

// ---------------------------------------------------------------------------
// Post-hook drain timeout
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for pending post-hooks before session cleanup. */
const POST_HOOK_DRAIN_TIMEOUT_MS = 5_000;

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

  /**
   * Per-session set of pending post-hook promises. Drained in onSessionEnd
   * before registry.cleanup() to prevent last-turn hooks from being aborted.
   */
  const pendingPostHooks = new Map<string, Set<Promise<unknown>>>();

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

  /**
   * Fire hooks without blocking the caller. The promise is tracked per-session
   * and drained before cleanup so last-turn hooks aren't silently aborted.
   */
  function fireAndForget(sessionId: string, event: HookEvent): void {
    const promise = registry
      .execute(sessionId, event)
      .catch(() => {
        /* post-call hooks are observational — errors silently swallowed */
      })
      .then(() => {
        // Self-remove from pending set once settled
        pendingPostHooks.get(sessionId)?.delete(promise);
      });

    let pending = pendingPostHooks.get(sessionId);
    if (pending === undefined) {
      pending = new Set();
      pendingPostHooks.set(sessionId, pending);
    }
    pending.add(promise);
  }

  /**
   * Wait for all pending post-hooks for a session with a bounded timeout.
   * After the timeout, remaining hooks are abandoned (cleanup will abort them).
   */
  async function drainPendingPostHooks(sessionId: string): Promise<void> {
    const pending = pendingPostHooks.get(sessionId);
    if (pending === undefined || pending.size === 0) {
      pendingPostHooks.delete(sessionId);
      return;
    }
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, POST_HOOK_DRAIN_TIMEOUT_MS)),
    ]);
    pendingPostHooks.delete(sessionId);
  }

  /** Build model.pre event data from a ModelRequest. */
  function buildModelPreData(request: ModelRequest): JsonObject {
    return {
      model: request.model ?? "default",
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      hasSystemPrompt: request.systemPrompt !== undefined,
    } as JsonObject;
  }

  /**
   * Run model.pre hooks and return the effective request.
   *
   * Note: registry.execute awaits ALL matching hooks before aggregateDecisions
   * can short-circuit on the first block. A slow hook delays the block decision
   * even if a faster hook already returned block. Flagged for future optimization.
   */
  async function dispatchModelPre(
    sessionId: string,
    ctx: TurnContext,
    request: ModelRequest,
  ): Promise<
    | { readonly blocked: true; readonly reason: string; readonly hookName?: string }
    | { readonly blocked: false; readonly request: ModelRequest }
  > {
    const preEvent = buildEvent(ctx.session, "compact.before", {
      data: buildModelPreData(request),
    });
    const preResults = await registry.execute(sessionId, preEvent);
    const aggregated = aggregateDecisions(preResults);

    if (aggregated.decision.kind === "block") {
      return {
        blocked: true,
        reason: aggregated.decision.reason,
        ...(aggregated.hookName !== undefined ? { hookName: aggregated.hookName } : {}),
      };
    }

    if (aggregated.decision.kind === "modify") {
      const safePatch = filterModelPatch(aggregated.decision.patch);
      if (safePatch !== undefined) {
        return { blocked: false, request: { ...request, ...safePatch } };
      }
    }

    return { blocked: false, request };
  }

  return {
    name: "hooks",
    phase: "resolve",
    priority: 400,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      registry.register(sessionId, ctx.agentId, hooks);
      const event = buildEvent(ctx, "session.started");
      const results = await registry.execute(sessionId, event);
      const aggregated = aggregateDecisions(results);
      if (aggregated.decision.kind === "block") {
        registry.cleanup(sessionId);
        throw new Error(formatBlockMessage("session", aggregated.decision.reason));
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      const event = buildEvent(ctx, "session.ended");
      // Awaited but decisions ignored — can't meaningfully block session end
      await registry.execute(sessionId, event);
      // Drain pending post-hooks before cleanup to prevent last-turn hooks
      // from being aborted by the session controller
      await drainPendingPostHooks(sessionId);
      registry.cleanup(sessionId);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.started");
      const results = await registry.execute(sessionId, event);
      const aggregated = aggregateDecisions(results);
      if (aggregated.decision.kind === "block") {
        throw new Error(formatBlockMessage("turn", aggregated.decision.reason));
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.ended");
      // After-turn hooks are fire-and-forget but tracked for drain
      fireAndForget(sessionId, event);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId as string;

      // Pre-call: blocking dispatch with decision aggregation
      const preEvent = buildEvent(ctx.session, "tool.before", {
        toolName: request.toolId,
        data: { input: request.input } as JsonObject,
      });
      const preResults = await registry.execute(sessionId, preEvent);
      const aggregated = aggregateDecisions(preResults);

      if (aggregated.decision.kind === "block") {
        return {
          output: { error: formatBlockMessage("tool_call", aggregated.decision.reason) },
          metadata: { blockedByHook: true, hookName: aggregated.hookName },
        };
      }

      const effectiveRequest: ToolRequest =
        aggregated.decision.kind === "modify"
          ? { ...request, input: { ...request.input, ...aggregated.decision.patch } }
          : request;

      const response = await next(effectiveRequest);

      // Post-call: fire-and-forget (use effective input, not original, for audit consistency)
      const postEvent = buildEvent(ctx.session, "tool.succeeded", {
        toolName: request.toolId,
        data: { input: effectiveRequest.input, output: response.output } as JsonObject,
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
      const preResult = await dispatchModelPre(sessionId, ctx, request);

      if (preResult.blocked) {
        // Observability: emit custom event for telemetry/audit (fire-and-forget)
        const blockEvent = buildEvent(ctx.session, "compact.blocked", {
          data: {
            reason: preResult.reason,
            hookName: preResult.hookName,
          } as JsonObject,
        });
        fireAndForget(sessionId, blockEvent);

        return {
          content: "",
          model: request.model ?? "unknown",
          stopReason: "hook_blocked",
          metadata: {
            reason: preResult.reason,
            hookName: preResult.hookName,
          },
        };
      }

      const response = await next(preResult.request);

      // Post-call: fire-and-forget
      const postEvent = buildEvent(ctx.session, "compact.after", {
        data: { model: response.model } as JsonObject,
      });
      fireAndForget(sessionId, postEvent);

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sessionId = ctx.session.sessionId as string;
      const preResult = await dispatchModelPre(sessionId, ctx, request);

      if (preResult.blocked) {
        // Observability: emit custom event for telemetry/audit (fire-and-forget)
        const blockEvent = buildEvent(ctx.session, "compact.blocked", {
          data: {
            reason: preResult.reason,
            hookName: preResult.hookName,
          } as JsonObject,
        });
        fireAndForget(sessionId, blockEvent);

        yield {
          kind: "error",
          message: formatBlockMessage("model_stream", preResult.reason),
          code: "PERMISSION",
          retryable: false,
        };
        return;
      }

      try {
        yield* next(preResult.request);
      } finally {
        // Post-call: fire-and-forget after stream completes or errors
        // Use effective model (from preResult), not original request model
        const postEvent = buildEvent(ctx.session, "compact.after", {
          data: { model: preResult.request.model ?? "default" } as JsonObject,
        });
        fireAndForget(sessionId, postEvent);
      }
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
