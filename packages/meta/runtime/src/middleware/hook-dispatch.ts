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
  RichTrajectoryStep,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
} from "@koi/core";
import { executeHooks } from "@koi/hooks";

/** Minimal registry interface for once-hook lifecycle tracking. */
export interface HookRegistryLike {
  readonly register: (sessionId: string, agentId: string, hooks: readonly HookConfig[]) => void;
  readonly execute: (
    sessionId: string,
    event: HookEvent,
  ) => Promise<readonly HookExecutionResult[]>;
  readonly cleanup: (sessionId: string) => void;
}

export interface HookDispatchConfig {
  /** Hook configurations loaded from the manifest. */
  readonly hooks: readonly HookConfig[];
  /** Trajectory store for recording hook execution steps. */
  readonly store?: TrajectoryDocumentStore;
  /** Document ID for trajectory recording. */
  readonly docId?: string;
  /** Session-level abort signal for cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Optional hook registry for once-hook lifecycle tracking.
   * When provided, hooks are dispatched through the registry (which
   * handles once-hook consumption) instead of calling executeHooks directly.
   * Requires registrySessionId to identify the session in the registry.
   */
  readonly registry?: HookRegistryLike;
  /** Session ID used for registry.execute(). Required when registry is set. */
  readonly registrySessionId?: string;
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
  const { hooks, store, docId, signal, registry, registrySessionId } = config;

  /** Truncate a string to a safe length for trajectory storage. */
  function truncateReason(s: string): string {
    return s.length <= 500 ? s : `${s.slice(0, 500)}…`;
  }

  /**
   * Summarize a JsonObject payload for trace metadata. Records field names
   * and value types/sizes but never raw values — prevents sensitive data
   * (e.g. from redaction hooks) from leaking into trajectory storage.
   */
  function summarizePayload(obj: JsonObject): JsonObject {
    const fields: Record<string, string> = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val === null || val === undefined) {
        fields[key] = "null";
      } else if (Array.isArray(val)) {
        fields[key] = `array(${val.length})`;
      } else if (typeof val === "object") {
        fields[key] = `object(${Object.keys(val as Record<string, unknown>).length} keys)`;
      } else {
        fields[key] = typeof val;
      }
    }
    return { fieldCount: Object.keys(obj).length, fields } as JsonObject;
  }

  /**
   * Extract a structured decision record from a hook execution result.
   * Fail-safe: serialization errors produce a fallback so tracing never
   * interrupts the hook enforcement or tool execution path.
   */
  function extractDecision(result: HookExecutionResult): JsonObject {
    try {
      if (!result.ok) {
        return { kind: "error", reason: truncateReason(result.error) } as JsonObject;
      }
      const { decision } = result;
      const base = (() => {
        switch (decision.kind) {
          case "block":
            return { kind: "block", reason: truncateReason(decision.reason) } as JsonObject;
          case "modify":
            return { kind: "modify", patch: summarizePayload(decision.patch) } as JsonObject;
          case "transform":
            return {
              kind: "transform",
              outputPatch: summarizePayload(decision.outputPatch),
              ...(decision.metadata !== undefined
                ? { metadata: summarizePayload(decision.metadata) }
                : {}),
            } as JsonObject;
          case "continue":
            return { kind: "continue" } as JsonObject;
        }
      })();
      if (result.executionFailed === true) {
        return { ...base, executionFailed: true } as JsonObject;
      }
      return base;
    } catch {
      // Fail-safe: non-serializable payloads (BigInt, circular, etc.)
      return { kind: "unserializable" } as JsonObject;
    }
  }

  /** Dispatch hooks through registry (once-hook aware) or direct executeHooks. */
  async function dispatchHooks(
    event: HookEvent,
    abortSignal?: AbortSignal,
  ): Promise<readonly HookExecutionResult[]> {
    if (registry !== undefined && registrySessionId !== undefined) {
      // Use the configured session ID and override the event's sessionId
      // to match what was registered. The registry enforces identity anyway.
      const registryEvent: HookEvent = { ...event, sessionId: registrySessionId };
      return registry.execute(registrySessionId, registryEvent);
    }
    return executeHooks(hooks, event, abortSignal);
  }

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
        decision: extractDecision(result),
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
  /**
   * Aggregate pre-execution hook decisions. Used for tool.before.
   * - Failed hooks with failClosed !== false → block (deny on failure)
   * - Failed hooks with failClosed: false → skip (fail-open)
   * - Successful block → block
   * - Successful modify → merge patches
   */
  function aggregatePreDecisions(results: readonly HookExecutionResult[]): HookDecision {
    // let: mutable — accumulates modify patches
    let mergedPatch: Record<string, unknown> | undefined;

    for (const result of results) {
      if (!result.ok) {
        if (result.failClosed !== false) {
          return { kind: "block", reason: `Hook ${result.hookName} failed: ${result.error}` };
        }
        continue;
      }
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

  /**
   * Check if any post-execution hooks failed. Used for tool.succeeded/tool.failed.
   * Post-hook failures always redact output (security: partial redaction is worse
   * than no redaction). Returns the failure reason or undefined if all passed.
   */
  function checkPostHookFailures(results: readonly HookExecutionResult[]): string | undefined {
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) return undefined;
    return `Post-hook(s) failed: ${failed.map((r) => r.hookName).join(", ")}`;
  }

  return {
    name: "hook-dispatch",
    phase: "observe",
    priority: 950,

    // turn.ended fires from onAfterTurn (engine turn boundary), NOT from
    // per-model-call wrappers. In a model→tool→model loop, wrapModelCall/
    // wrapModelStream fire per model invocation, but turn.ended should fire
    // exactly once per user turn.
    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Record stop-gate block as a trajectory step before skipping turn.ended.
      if (ctx.stopBlocked === true) {
        if (store !== undefined && docId !== undefined) {
          const step: RichTrajectoryStep = {
            stepIndex: 0,
            timestamp: Date.now(),
            source: "system" as const,
            kind: "model_call" as const,
            identifier: "stop-gate:block",
            outcome: "retry" as const,
            durationMs: 0,
            request: { text: `Stop blocked by ${ctx.stopGateBlockedBy ?? "unknown"}` },
            metadata: {
              type: "stop_gate_decision",
              blockedBy: ctx.stopGateBlockedBy ?? "unknown",
              reasonLength: (ctx.stopGateReason ?? "").length,
              turnIndex: ctx.turnIndex,
            } as JsonObject,
          };
          // Await with error swallowing — same pattern as recordHookResults.
          // Ensures ordering (veto step indexed before retry) without stalling
          // on store errors (catch swallows).
          await store.append(docId, [step]).catch(() => {});
        }
        return;
      }
      try {
        const event: HookEvent = {
          event: "turn.ended",
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId as string,
        };
        const results = await dispatchHooks(event, ctx.signal ?? signal);
        await recordHookResults(results, "turn.ended");
      } catch {
        // Observer hook dispatch — swallow to avoid breaking the turn loop
      }
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
      const preResults = await dispatchHooks(preEvent, ctx.signal ?? signal);
      await recordHookResults(preResults, `tool.before:${request.toolId}`);

      // Enforce pre-execution decisions
      const decision = aggregatePreDecisions(preResults);
      if (decision.kind === "block") {
        throw new Error(`Hook blocked tool ${request.toolId}: ${decision.reason}`);
      }

      // Apply modify patches to tool input
      const effectiveRequest =
        decision.kind === "modify"
          ? { ...request, input: { ...request.input, ...decision.patch } }
          : request;

      // Execute the tool
      // let: mutable — tracks whether tool succeeded
      let response: ToolResponse | undefined;
      let toolError: unknown;
      try {
        response = await next(effectiveRequest);
      } catch (e: unknown) {
        toolError = e;
      }

      // Post-execution hooks: tool.succeeded or tool.failed
      try {
        const postEventName = toolError === undefined ? "tool.succeeded" : "tool.failed";
        const postEvent: HookEvent = {
          event: postEventName,
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId as string,
          toolName: request.toolId,
        };
        const postResults = await dispatchHooks(postEvent, ctx.signal ?? signal);
        await recordHookResults(postResults, `${postEventName}:${request.toolId}`);

        // Post-hook failures redact output (security: partial redaction is
        // worse than no redaction). The tool already ran and side effects
        // are committed, but raw output is suppressed.
        const postFailure = checkPostHookFailures(postResults);
        if (postFailure !== undefined && response !== undefined) {
          return {
            output: `[output redacted: ${postFailure}]`,
            ...(response.metadata !== undefined
              ? { metadata: { ...response.metadata, committedButRedacted: true } }
              : { metadata: { committedButRedacted: true } }),
          };
        }
      } catch {
        // Hook dispatch itself failed — redact to be safe
        if (response !== undefined) {
          return {
            output: "[output redacted: post-hook dispatch error]",
            metadata: { committedButRedacted: true },
          };
        }
      }

      // Return original result or re-throw original error
      if (toolError !== undefined) throw toolError;
      return response as ToolResponse;
    },

    describeCapabilities: () => ({
      label: "Hook Dispatch",
      description: `${hooks.length} hook(s) configured for event-driven execution`,
    }),
  };
}
