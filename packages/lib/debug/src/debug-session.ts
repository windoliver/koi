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

export function createDebugSession(config: CreateDebugSessionConfig): DebugSession {
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

  const session: DebugSession = {
    id,
    agentId: agent.pid.id,

    detach: (): void => {
      if (detached) return;
      detached = true;
      if (controller.isPaused()) {
        controller.releaseGate();
      }
      controller.deactivate();
      unsubMw();
      emitToSession({ kind: "detached", debugSessionId: id, reason: "user" });
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

      if (until !== undefined) {
        const bpResult = controller.addBreakpoint(until, { once: true, label: "step-until" });
        if (!bpResult.ok) return bpResult;
      } else {
        const targetTurn = controller.turnIndex() + count;
        controller.addBreakpoint(
          { kind: "turn", turnIndex: targetTurn },
          { once: true, label: "step-target" },
        );
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

    inspect: (tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot => buildSnapshot(tokens),

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
      const result = controller.addBreakpoint(predicate, options);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    },

    removeBreakpoint: (bpId: BreakpointId): boolean => controller.removeBreakpoint(bpId),

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

    events: (limit?: number): readonly EngineEvent[] => controller.eventBuffer().tail(limit),

    createObserver: (): DebugObserver =>
      createDebugObserver({
        agent,
        controller,
        debugSessionId: id,
        sessionId: snapshotSessionId,
      }),
  };

  return session;
}

function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isSerializable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
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
