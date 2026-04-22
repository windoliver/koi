import type {
  Agent,
  Breakpoint,
  BreakpointId,
  BreakpointOptions,
  BreakpointPredicate,
  ComponentMetadata,
  ComponentSnapshot,
  DebugEvent,
  DebugObserver,
  DebugSession,
  DebugSnapshot,
  DebugState,
  EngineEvent,
  InspectComponentOptions,
  KoiError,
  Result,
  StepOptions,
  SubsystemToken,
} from "@koi/core";
import { DEFAULT_INSPECT_LIMIT, debugSessionId } from "@koi/core";
import type { DebugController } from "./debug-middleware.js";
import { createDebugObserver } from "./debug-observer.js";

export interface CreateDebugSessionConfig {
  readonly agent: Agent;
  readonly controller: DebugController;
  readonly sessionId?: string | undefined;
}

type DetachReason = "user" | "agent_terminated" | "replaced";

/** Custom event types emitted on failure paths — used by step() to catch errors. */
const STEP_ERROR_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "tool_call_error",
  "model_call_error",
  "model_stream_error",
]);

export interface CreateDebugSessionResult {
  readonly session: DebugSession;
  /** Internal teardown with a specific detach reason (for lifecycle-driven revocation). */
  readonly detachWithReason: (reason: DetachReason) => void;
}

export function createDebugSession(config: CreateDebugSessionConfig): DebugSession {
  return createDebugSessionInternal(config).session;
}

export function createDebugSessionInternal(
  config: CreateDebugSessionConfig,
): CreateDebugSessionResult {
  const { agent, controller } = config;
  const id = debugSessionId(crypto.randomUUID());
  const snapshotSessionId = config.sessionId ?? (id as string);

  // let justified: mutable state tracking
  let detached = false;
  const attachedSince = new Date().toISOString();

  controller.activate();
  controller.setSessionId(id);

  const listeners = new Set<(event: DebugEvent) => void>();

  function emitToSession(event: DebugEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  const unsubMw = controller.onDebugEvent(emitToSession);

  emitToSession({ kind: "attached", debugSessionId: id, agentId: agent.pid.id });

  function assertNotDetached(): Result<void, KoiError> {
    if (detached) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Debug session is detached", retryable: false },
      };
    }
    return { ok: true, value: undefined };
  }

  function assertPaused(): Result<void, KoiError> {
    const check = assertNotDetached();
    if (!check.ok) return check;
    if (!controller.isPaused()) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Agent is not paused — step/resume only valid when paused",
          retryable: false,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  function buildSnapshot(tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot {
    const components = agent.components();
    const metadata: ComponentMetadata[] = [];

    for (const [key, value] of components) {
      if (tokens !== undefined && !tokens.some((t) => (t as string) === key)) {
        continue;
      }
      metadata.push({
        token: key,
        typeHint: typeof value,
        approximateBytes: estimateSize(value),
        serializable: isSerializable(value),
      });
    }

    return {
      agentId: agent.pid.id,
      sessionId: snapshotSessionId,
      debugSessionId: id,
      processState: agent.state,
      turnIndex: controller.turnIndex(),
      components: metadata,
      breakpoints: controller.breakpoints(),
      eventBufferSize: controller.eventBuffer().size(),
      timestamp: new Date().toISOString(),
    };
  }

  function teardown(reason: DetachReason): void {
    if (detached) return;
    detached = true;
    // Emit detached through controller BEFORE deactivation so observers see it
    controller.emitEvent({ kind: "detached", debugSessionId: id, reason });
    if (controller.isPaused()) {
      controller.releaseGate();
    }
    controller.deactivate();
    unsubMw();
  }

  const session: DebugSession = {
    id,
    agentId: agent.pid.id,

    detach: (): void => {
      teardown("user");
    },

    step: (options?: StepOptions): Result<void, KoiError> => {
      const check = assertPaused();
      if (!check.ok) return check;

      const count = options?.count ?? 1;
      const until = options?.until;

      if (until === undefined && (!Number.isInteger(count) || count <= 0)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `step count must be a positive integer, got ${String(count)}`,
            retryable: false,
          },
        };
      }

      // Remove any residual step-owned breakpoints from a previous step() call
      const STEP_LABELS = new Set(["step-event", "step-target", "step-until"]);
      for (const bp of controller.breakpoints()) {
        if (bp.label !== undefined && STEP_LABELS.has(bp.label)) {
          controller.removeBreakpoint(bp.id);
        }
      }

      if (until !== undefined) {
        const bpResult = controller.addBreakpoint(until, { once: true, label: "step-until" });
        if (!bpResult.ok) return bpResult;
      } else {
        const pausedEvent = controller.pausedEvent();
        const isIntraTurn =
          pausedEvent !== undefined &&
          pausedEvent.kind !== "turn_start" &&
          pausedEvent.kind !== "turn_end";

        if (isIntraTurn) {
          // Paused on an intra-turn event — arm two one-shot BPs so step()
          // pauses deterministically on BOTH normal turn-end AND error
          // custom events. The custom BP uses an internal filter so only
          // error types fire (not benign thinking_delta/usage/model_call_*).
          const bpEnd = controller.addBreakpoint(
            { kind: "event_kind", eventKind: "turn_end" },
            { once: true, label: "step-event" },
          );
          if (!bpEnd.ok) return bpEnd;
          const bpErr = controller.addBreakpoint(
            { kind: "event_kind", eventKind: "custom" },
            { once: true, label: "step-event" },
            { customTypeFilter: STEP_ERROR_CUSTOM_TYPES },
          );
          if (!bpErr.ok) return bpErr;
        } else {
          const targetTurn = controller.turnIndex() + count;
          const bpResult = controller.addBreakpoint(
            { kind: "turn", turnIndex: targetTurn },
            { once: true, label: "step-target" },
          );
          if (!bpResult.ok) return bpResult;
        }
      }

      controller.releaseGate();
      return { ok: true, value: undefined };
    },

    resume: (): Result<void, KoiError> => {
      const check = assertPaused();
      if (!check.ok) return check;
      controller.releaseGate();
      return { ok: true, value: undefined };
    },

    inspect: (tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot => {
      if (detached) {
        throw new Error("Debug session is detached");
      }
      return buildSnapshot(tokens);
    },

    inspectComponent: (
      token: SubsystemToken<unknown>,
      options?: InspectComponentOptions,
    ): Result<ComponentSnapshot, KoiError> => {
      const check = assertNotDetached();
      if (!check.ok) return check;

      const value = agent.component(token);
      if (value === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Component not found: ${token as string}`,
            retryable: false,
          },
        };
      }

      const limit = options?.limit ?? DEFAULT_INSPECT_LIMIT;
      const offset = options?.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `offset and limit must be non-negative integers, got offset=${String(offset)}, limit=${String(limit)}`,
            retryable: false,
          },
        };
      }
      const paginated = paginateData(value, offset, limit);

      let snapshot: unknown;
      try {
        snapshot = structuredClone(paginated.data);
      } catch {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Component ${token as string} is not cloneable; cannot expose a safe snapshot`,
            retryable: false,
          },
        };
      }

      return {
        ok: true,
        value: {
          token: token as string,
          data: snapshot,
          totalItems: paginated.totalItems,
          offset,
          limit,
          hasMore: paginated.hasMore,
        },
      };
    },

    breakOn: (predicate: BreakpointPredicate, options?: BreakpointOptions): Breakpoint => {
      if (detached) {
        throw new Error("Debug session is detached");
      }
      const result = controller.addBreakpoint(predicate, options);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    },

    removeBreakpoint: (bpId: BreakpointId): boolean => {
      if (detached) return false;
      return controller.removeBreakpoint(bpId);
    },

    onDebugEvent: (listener: (event: DebugEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    state: (): DebugState => {
      if (detached) return { kind: "detached" };
      if (controller.isPaused()) {
        return {
          kind: "paused",
          since: new Date().toISOString(),
          breakpointId: controller.pausedBreakpointId(),
          turnIndex: controller.turnIndex(),
          event: controller.pausedEvent(),
        };
      }
      return { kind: "attached", since: attachedSince };
    },

    events: (limit?: number): readonly EngineEvent[] => {
      if (detached) return [];
      return controller.eventBuffer().tail(limit);
    },

    createObserver: (): DebugObserver => {
      if (detached) {
        throw new Error("Debug session is detached");
      }
      return createDebugObserver({
        agent,
        controller,
        debugSessionId: id,
        sessionId: snapshotSessionId,
      });
    },
  };

  return { session, detachWithReason: teardown };
}

/**
 * Cheap, bounded size estimate for component metadata. Does NOT fully serialize
 * large objects — uses type/shape heuristics to avoid CPU spikes on
 * maps/transcripts/embeddings during routine inspect() calls.
 */
function estimateSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length * 8;
  if (value instanceof Map || value instanceof Set) return value.size * 16;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length * 16;
  }
  return 0;
}

/**
 * Cheap serializability check based on type heuristics. Avoids full
 * structuredClone on every component — defers deep cloning to explicit
 * inspectComponent() calls which already use structuredClone at that point.
 */
function isSerializable(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t === "function" || t === "symbol") return false;
  // For objects: assume plain objects are serializable. Deep check happens
  // later in inspectComponent() where structuredClone catches the real cases.
  return t === "object";
}

interface PaginatedResult {
  readonly data: unknown;
  readonly totalItems?: number | undefined;
  readonly hasMore: boolean;
}

function paginateData(value: unknown, offset: number, limit: number): PaginatedResult {
  if (Array.isArray(value)) {
    return {
      data: value.slice(offset, offset + limit),
      totalItems: value.length,
      hasMore: offset + limit < value.length,
    };
  }

  if (value instanceof Map) {
    const entries = [...value.entries()];
    return {
      data: Object.fromEntries(entries.slice(offset, offset + limit)),
      totalItems: entries.length,
      hasMore: offset + limit < entries.length,
    };
  }

  return { data: value, hasMore: false };
}
