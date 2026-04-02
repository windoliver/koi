/**
 * Hook dispatch middleware — fires user-defined hooks on model/tool events
 * and records hook execution as system steps in the ATIF trajectory.
 *
 * Uses canonical event names from @koi/core (HOOK_EVENT_KINDS):
 * - tool.before: pre-execution, supports block/modify decisions
 * - tool.succeeded: post-execution on success (observe only)
 * - tool.failed: post-execution on failure (observe only)
 *
 * Hook decisions are enforced:
 * - block: throws an error to prevent the operation
 * - modify: patches the request input before proceeding
 * - continue: no-op, proceed normally
 */

import type {
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
  RichTrajectoryStep,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
} from "@koi/core";
import { executeHooks } from "@koi/hooks";

export interface HookDispatchConfig {
  /** Hook configurations loaded from the manifest. */
  readonly hooks: readonly HookConfig[];
  /** Trajectory store for recording hook execution steps. */
  readonly store?: TrajectoryDocumentStore;
  /** Document ID for trajectory recording. */
  readonly docId?: string;
  /** Session-level abort signal for cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Creates a middleware that dispatches hooks on model/tool call events
 * and records each execution as an ATIF trajectory step.
 *
 * Hook decisions are enforced for pre-execution hooks (tool.before):
 * - block: throws to prevent the operation
 * - modify: patches request.input before proceeding
 */
export function createHookDispatchMiddleware(config: HookDispatchConfig): KoiMiddleware {
  const { hooks, store, docId, signal } = config;

  async function recordHookResults(
    results: readonly HookExecutionResult[],
    triggerEvent: string,
  ): Promise<void> {
    if (store === undefined || docId === undefined || results.length === 0) return;

    const steps: RichTrajectoryStep[] = results.map((result, index) => ({
      stepIndex: index,
      timestamp: Date.now(),
      source: "system" as const,
      kind: "model_call" as const,
      identifier: `hook:${result.hookName}`,
      outcome: result.ok ? ("success" as const) : ("failure" as const),
      durationMs: result.durationMs,
      request: { text: `${triggerEvent} → ${result.hookName}` },
      ...(!result.ok ? { error: { text: result.error } } : {}),
      metadata: {
        type: "hook_execution",
        triggerEvent,
        hookName: result.hookName,
      } as JsonObject,
    }));

    await store.append(docId, steps).catch(() => {
      // Best-effort — don't break the chain for trajectory failures
    });
  }

  /**
   * Aggregate hook decisions. First block wins, modify patches are merged
   * in order (last writer wins per key).
   */
  function aggregateDecisions(results: readonly HookExecutionResult[]): HookDecision {
    // let: mutable — accumulates modify patches
    let mergedPatch: Record<string, unknown> | undefined;

    for (const result of results) {
      if (!result.ok) continue;
      const { decision } = result;
      if (decision.kind === "block") return decision;
      if (decision.kind === "modify") {
        if (mergedPatch === undefined) {
          mergedPatch = { ...decision.patch };
        } else {
          Object.assign(mergedPatch, decision.patch);
        }
      }
    }

    if (mergedPatch !== undefined) {
      return { kind: "modify", patch: mergedPatch as JsonObject };
    }
    return { kind: "continue" };
  }

  return {
    name: "hook-dispatch",
    phase: "observe",
    priority: 950,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const response = await next(request);

      // Post-execution: turn.ended (observe only, no decisions enforced)
      const event: HookEvent = {
        event: "turn.ended",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
      };
      const results = await executeHooks(hooks, event, ctx.signal ?? signal);
      await recordHookResults(results, "turn.ended");

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      yield* next(request);

      // Post-execution: turn.ended (observe only, same as wrapModelCall)
      const event: HookEvent = {
        event: "turn.ended",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
      };
      const results = await executeHooks(hooks, event, ctx.signal ?? signal);
      await recordHookResults(results, "turn.ended");
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Pre-execution: tool.before — supports block/modify decisions
      const preEvent: HookEvent = {
        event: "tool.before",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
        toolName: request.toolId,
      };
      const preResults = await executeHooks(hooks, preEvent, ctx.signal ?? signal);
      await recordHookResults(preResults, `tool.before:${request.toolId}`);

      // Enforce pre-execution decisions
      const decision = aggregateDecisions(preResults);
      if (decision.kind === "block") {
        throw new Error(`Hook blocked tool ${request.toolId}: ${decision.reason}`);
      }

      // Apply modify patches to tool input
      const effectiveRequest =
        decision.kind === "modify"
          ? { ...request, input: { ...request.input, ...decision.patch } }
          : request;

      // let: mutable — tracks whether tool succeeded
      let response: ToolResponse | undefined;
      let toolError: unknown;
      try {
        response = await next(effectiveRequest);
        return response;
      } catch (e: unknown) {
        toolError = e;
        throw e;
      } finally {
        // Post-execution: tool.succeeded or tool.failed (observe only)
        const postEventName = toolError === undefined ? "tool.succeeded" : "tool.failed";
        const postEvent: HookEvent = {
          event: postEventName,
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId as string,
          toolName: request.toolId,
        };
        const postResults = await executeHooks(hooks, postEvent, ctx.signal ?? signal);
        await recordHookResults(postResults, `${postEventName}:${request.toolId}`);
      }
    },

    describeCapabilities: () => ({
      label: "Hook Dispatch",
      description: `${hooks.length} hook(s) configured for event-driven execution`,
    }),
  };
}
