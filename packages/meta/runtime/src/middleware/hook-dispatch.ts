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
 *
 * TODO(hook-dispatch-unification): this middleware currently runs in parallel
 * with @koi/hooks createHookMiddleware, which dispatches the same tool events
 * with full payload data and an agentExecutor wired via spawnFn. That path
 * handles agent hooks; this path only handles command/http hooks (calls
 * executeHooks with no agentExecutor) and records ATIF steps. The split means
 * tool events fire twice per call, agent hooks silently no-op here, and
 * observability is wired to the weaker dispatcher.
 *
 * Claude Code's production hook system uses a single dispatcher per event
 * (see src/utils/hooks.ts:3450 executePostToolHooks) with full payload + an
 * observer tap (src/utils/hooks/hookEvents.ts:61). We should mirror that:
 * make @koi/hooks the sole dispatcher and turn this middleware into a pure
 * observer that subscribes to hook-execution events and only records ATIF
 * steps. Tracked as a follow-up to #1491.
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
    abortSignal?: AbortSignal,
  ) => Promise<readonly HookExecutionResult[]>;
  readonly cleanup: (sessionId: string) => void;
  /**
   * Returns true if the session has registered hooks. Optional so test
   * doubles can omit it; when absent, the middleware falls back to
   * fail-closed assumptions.
   */
  readonly has?: (sessionId: string) => boolean;
  /**
   * Returns true if the session has any registered hook whose filter
   * matches the given event. Optional; when absent, the middleware
   * falls back to `has` (then to fail-closed).
   */
  readonly hasMatching?: (sessionId: string, event: HookEvent) => boolean;
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
   *
   * The registry is keyed on the live runtime session (ctx.session.sessionId)
   * for each dispatch — callers are responsible for calling
   * registry.register(sessionId, agentId, hooks) for each session they want
   * once-hook tracking on, and registry.cleanup(sessionId) at session end.
   * Sessions that have not been registered produce no hook results (see
   * HookRegistry.execute contract), so the middleware degrades cleanly.
   */
  readonly registry?: HookRegistryLike;
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
  const { hooks, store, docId, signal, registry } = config;

  /**
   * Does ANY configured hook have a filter that could match post-tool
   * events (tool.succeeded / tool.failed) for the given toolId? Used to
   * gate cancel-redaction per-call: if no post-hook could have matched
   * this specific tool, a late caller abort is not bypassing any
   * fail-closed contract and we return the raw output.
   *
   * Registry path: we cannot introspect registered hooks from outside,
   * so we fail closed (return true and redact on cancel).
   */
  function hasPostHookFor(toolId: string, sessionId: string, agentId: string): boolean {
    if (registry !== undefined) {
      // Prefer the tight `hasMatching` query — asks the registry whether
      // any registered hook's filter matches tool.succeeded/tool.failed for
      // this specific tool. Falls back to `has` (any hooks at all), then
      // to fail-closed when neither introspection method exists.
      if (registry.hasMatching !== undefined) {
        return (
          registry.hasMatching(sessionId, {
            event: "tool.succeeded",
            agentId,
            sessionId,
            toolName: toolId,
          }) ||
          registry.hasMatching(sessionId, {
            event: "tool.failed",
            agentId,
            sessionId,
            toolName: toolId,
          })
        );
      }
      if (registry.has !== undefined) return registry.has(sessionId);
      return true;
    }
    return hooks.some((h) => {
      const filter = h.filter;
      // No filter = match all events and tools.
      if (filter === undefined) return true;
      // Event-side check.
      const eventMatches =
        filter.events === undefined ||
        filter.events.some((ev) => ev === "tool.succeeded" || ev === "tool.failed" || ev === "*");
      if (!eventMatches) return false;
      // Tool-side check: if filter.tools is present, this tool must be in it.
      const toolMatches = filter.tools === undefined || filter.tools.includes(toolId);
      return toolMatches;
    });
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
        return { kind: "error", reasonLength: result.error.length } as JsonObject;
      }
      const { decision } = result;
      const base = (() => {
        switch (decision.kind) {
          case "block":
            return { kind: "block", reasonLength: decision.reason.length } as JsonObject;
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

  /**
   * Dispatch hooks through the registry (once-hook aware, keyed on the live
   * runtime session) or direct executeHooks. event.sessionId is the live
   * session id from TurnContext, so the registry is addressed per-session
   * and once-hook consumption stays scoped to the caller's session.
   */
  async function dispatchHooks(
    event: HookEvent,
    abortSignal?: AbortSignal,
  ): Promise<readonly HookExecutionResult[]> {
    if (registry !== undefined) {
      return registry.execute(event.sessionId, event, abortSignal);
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
      ...(!result.ok ? { error: { text: `hook error (${result.error.length} chars)` } } : {}),
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
      // Fail closed on cancellation: if the caller has already aborted, abort
      // the tool call before dispatching hooks. Otherwise registry-backed
      // hooks short-circuit on the aborted signal (returning []), which
      // aggregatePreDecisions would interpret as "continue" — bypassing
      // fail-closed pre-hooks and letting the tool run under cancellation.
      const effectiveSignal = ctx.signal ?? signal;
      if (effectiveSignal?.aborted === true) {
        throw new DOMException(
          `Tool call ${request.toolId} aborted before hook dispatch`,
          "AbortError",
        );
      }
      // Pre-execution: tool.before — supports block/modify decisions
      const preEvent: HookEvent = {
        event: "tool.before",
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId as string,
        toolName: request.toolId,
      };
      const preResults = await dispatchHooks(preEvent, effectiveSignal);
      await recordHookResults(preResults, `tool.before:${request.toolId}`);

      // Re-check cancellation after dispatch. If the signal aborted while
      // pre-hooks were running, the registry returned [] and aggregating
      // that as "continue" would let the tool run under cancellation,
      // bypassing any fail-closed pre-hooks that were interrupted. The
      // explicit-undefined form avoids the narrowing that `?.aborted`
      // would inherit from the pre-dispatch guard above — the signal can
      // flip to aborted during the `await dispatchHooks(...)`.
      // biome-ignore lint/complexity/useOptionalChain: narrowing workaround
      if (effectiveSignal !== undefined && effectiveSignal.aborted) {
        throw new DOMException(
          `Tool call ${request.toolId} aborted during pre-hook dispatch`,
          "AbortError",
        );
      }

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
        const postResults = await dispatchHooks(postEvent, effectiveSignal);
        await recordHookResults(postResults, `${postEventName}:${request.toolId}`);

        // Fail closed on cancellation: if the caller's signal aborted during
        // post-hook dispatch AND the middleware is configured with at least
        // one hook that could match post-tool events, registry.execute()
        // may have returned [] under cancellation and silently skipped a
        // fail-closed post-hook (output redaction, audit). The tool already
        // ran and side effects are committed, so we redact defensively.
        // When no post-hook candidate exists at all, a late abort is not
        // bypassing any contract and the raw output is returned normally.
        // biome-ignore lint/complexity/useOptionalChain: narrowing workaround
        const postAborted = effectiveSignal !== undefined && effectiveSignal.aborted;
        // Only redact when post-hooks actually got skipped: results must be
        // empty (dispatched but short-circuited on cancel) AND a matching
        // post-hook could have run. If postResults is non-empty, hooks DID
        // run and checkPostHookFailures below will honor their decisions;
        // redacting on top of that would be double-redaction and would
        // corrupt successful tool output races with late aborts.
        if (
          postAborted &&
          postResults.length === 0 &&
          hasPostHookFor(request.toolId, ctx.session.sessionId as string, ctx.session.agentId) &&
          response !== undefined
        ) {
          return {
            output: "[output redacted: post-hooks skipped due to cancellation]",
            ...(response.metadata !== undefined
              ? { metadata: { ...response.metadata, committedButRedacted: true } }
              : { metadata: { committedButRedacted: true } }),
          };
        }

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
