/**
 * Hook observer middleware — records hook execution as ATIF trajectory steps.
 *
 * This middleware is a pure observer: it does NOT dispatch hooks or enforce
 * decisions. Hook dispatch is owned exclusively by @koi/hooks
 * `createHookMiddleware`, which fires events with full payload data via its
 * internal HookRegistry. This module subscribes to the registry's `onExecuted`
 * tap to record each execution as an ATIF `hook_execution` step.
 *
 * The middleware component (`onAfterTurn`) records stop-gate ATIF steps only.
 */

import type {
  HookEvent,
  HookExecutionResult,
  JsonObject,
  KoiMiddleware,
  RichContent,
  RichTrajectoryStep,
  TrajectoryDocumentStore,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HookObserverConfig {
  /** Trajectory store for recording hook execution steps. */
  readonly store?: TrajectoryDocumentStore;
  /** Document ID for trajectory recording. */
  readonly docId?: string;
  /** Session-level abort signal for cancellation. */
  readonly signal?: AbortSignal;
  /** Injectable clock for deterministic timestamps. Default: Date.now. */
  readonly clock?: () => number;
}

// ---------------------------------------------------------------------------
// ATIF recording helpers
// ---------------------------------------------------------------------------

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

const MAX_ERROR_LENGTH = 512;

function truncateError(error: string): RichContent {
  if (error.length <= MAX_ERROR_LENGTH) {
    return { text: error };
  }
  // Avoid splitting a UTF-16 surrogate pair at the boundary
  let end = MAX_ERROR_LENGTH;
  const code = error.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1; // high surrogate at boundary — back up one
  }
  return {
    text: error.slice(0, end),
    truncated: true,
    originalSize: new TextEncoder().encode(error).byteLength,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a hook observer: an `onExecuted` tap for the @koi/hooks registry
 * and a minimal middleware for stop-gate ATIF recording.
 *
 * Wire `onExecuted` into `createHookMiddleware({ ..., onExecuted })` so the
 * registry notifies this observer after every hook dispatch.
 */
export function createHookObserver(config: HookObserverConfig): {
  /** Tap callback — wire into CreateHookMiddlewareOptions.onExecuted. */
  readonly onExecuted: (results: readonly HookExecutionResult[], event: HookEvent) => void;
  /** Middleware with onAfterTurn for stop-gate ATIF recording only. */
  readonly middleware: KoiMiddleware;
} {
  const { store, docId } = config;
  const clock = config.clock ?? Date.now;

  function recordHookResults(results: readonly HookExecutionResult[], triggerEvent: string): void {
    if (store === undefined || docId === undefined || results.length === 0) return;

    const steps: RichTrajectoryStep[] = results.map((result, index) => ({
      stepIndex: index,
      timestamp: clock(),
      source: "system" as const,
      kind: "model_call" as const,
      identifier: `hook:${result.hookName}`,
      outcome: result.ok ? ("success" as const) : ("failure" as const),
      durationMs: result.durationMs,
      request: { text: `${triggerEvent} → ${result.hookName}` },
      ...(!result.ok ? { error: truncateError(result.error) } : {}),
      metadata: {
        type: "hook_execution",
        triggerEvent,
        hookName: result.hookName,
        decision: extractDecision(result),
      } as JsonObject,
    }));

    void store.append(docId, steps).catch(() => {
      // Best-effort — don't break the chain for trajectory failures
    });
  }

  const onExecuted = (results: readonly HookExecutionResult[], event: HookEvent): void => {
    recordHookResults(results, event.event);
  };

  const middleware: KoiMiddleware = {
    name: "hook-observer",
    phase: "observe",
    priority: 950,

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Record stop-gate block as a trajectory step.
      if (ctx.stopBlocked === true) {
        if (store !== undefined && docId !== undefined) {
          const step: RichTrajectoryStep = {
            stepIndex: 0,
            timestamp: clock(),
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
          // Fire-and-forget — store latency must not block the retry path.
          void store.append(docId, [step]).catch(() => {});
        }
      }
    },

    describeCapabilities: () => ({
      label: "Hook Observer",
      description: "Records hook execution as ATIF trajectory steps",
    }),
  };

  return { onExecuted, middleware };
}
