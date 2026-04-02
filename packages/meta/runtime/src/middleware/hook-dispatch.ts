/**
 * Hook dispatch middleware — fires user-defined hooks on model/tool events
 * and records hook execution as system steps in the ATIF trajectory.
 *
 * Wraps model and tool calls to dispatch matching hooks via @koi/hooks
 * executeHooks(). Each hook execution is recorded as a RichTrajectoryStep
 * with source: "system" for visibility in the trajectory.
 */

import type {
  HookConfig,
  HookEvent,
  HookExecutionResult,
  JsonObject,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
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
 */
export function createHookDispatchMiddleware(config: HookDispatchConfig): KoiMiddleware {
  const { hooks, store, docId, signal } = config;

  async function recordHookResults(
    results: readonly HookExecutionResult[],
    triggerEvent: string,
  ): Promise<void> {
    if (store === undefined || docId === undefined || results.length === 0) return;

    const steps: RichTrajectoryStep[] = results.map((result, index) => ({
      stepIndex: index, // Corrected by store's global counter
      timestamp: Date.now(),
      source: "system" as const,
      kind: "model_call" as const, // Maps to message field in ATIF (not tool_calls)
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

  return {
    name: "hook-dispatch",
    phase: "observe",
    priority: 950, // After event-trace (100), near the end of observe phase

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const response = await next(request);

      // Fire hooks for model call completion
      const event: HookEvent = {
        event: "model.completed",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
      };
      // Prefer live turn signal (carries timeout/cancel) over static config signal
      const results = await executeHooks(hooks, event, ctx.signal ?? signal);
      await recordHookResults(results, "model.completed");

      return response;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Fire pre-execution hooks
      const preEvent: HookEvent = {
        event: "tool.executing",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
        toolName: request.toolId,
      };
      const preResults = await executeHooks(hooks, preEvent, ctx.signal ?? signal);
      await recordHookResults(preResults, `tool.executing:${request.toolId}`);

      const response = await next(request);

      // Fire post-execution hooks
      const postEvent: HookEvent = {
        event: "tool.executed",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
        toolName: request.toolId,
      };
      const postResults = await executeHooks(hooks, postEvent, ctx.signal ?? signal);
      await recordHookResults(postResults, `tool.executed:${request.toolId}`);

      return response;
    },

    describeCapabilities: () => ({
      label: "Hook Dispatch",
      description: `${hooks.length} hook(s) configured for event-driven execution`,
    }),
  };
}
