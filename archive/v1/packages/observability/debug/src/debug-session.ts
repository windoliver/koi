/**
 * DebugSession — single-attach debug controller with state machine.
 *
 * Lifecycle:
 * - Attach: activate middleware, state → attached
 * - Breakpoint hit: state → paused
 * - Step/Resume: release gate, state → attached
 * - Detach: auto-resume if paused, deactivate middleware, state → detached
 */

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateDebugSessionConfig {
  readonly agent: Agent;
  readonly controller: DebugController;
  /** Engine session ID for snapshot correlation. Defaults to debugSessionId. */
  readonly sessionId?: string | undefined;
}

/** Create a DebugSession for a given agent and middleware controller. */
export function createDebugSession(config: CreateDebugSessionConfig): DebugSession {
  const { agent, controller } = config;
  const id = debugSessionId(crypto.randomUUID());
  const snapshotSessionId = config.sessionId ?? (id as string);

  // let justified: mutable state tracking
  let detached = false;
  const attachedSince = new Date().toISOString();

  // Activate the middleware and bind session ID for event correlation
  controller.activate();
  controller.setSessionId(id);

  // Emit attached event
  const listeners = new Set<(event: DebugEvent) => void>();

  function emitToSession(event: DebugEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  // Forward middleware debug events to session listeners
  const unsubMw = controller.onDebugEvent(emitToSession);

  emitToSession({
    kind: "attached",
    debugSessionId: id,
    agentId: agent.pid.id,
  });

  function assertNotDetached(): Result<void, KoiError> {
    if (detached) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Debug session is detached",
          retryable: false,
        },
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

    detach: () => {
      if (detached) return;
      detached = true;

      // Auto-resume if paused
      if (controller.isPaused()) {
        controller.releaseGate();
      }

      controller.deactivate();
      unsubMw();

      emitToSession({
        kind: "detached",
        debugSessionId: id,
        reason: "user",
      });
    },

    step: (options?: StepOptions) => {
      const check = assertPaused();
      if (!check.ok) return check;

      const count = options?.count ?? 1;
      const until = options?.until;

      if (until !== undefined) {
        // Install a one-shot breakpoint for the "until" predicate, then resume
        controller.addBreakpoint(until, { once: true, label: "step-until" });
      } else {
        // Install a one-shot breakpoint at the target turn index (including count === 1)
        const targetTurn = controller.turnIndex() + count;
        controller.addBreakpoint(
          { kind: "turn", turnIndex: targetTurn },
          { once: true, label: "step-target" },
        );
      }

      // Release the gate to allow execution
      controller.releaseGate();

      return { ok: true, value: undefined };
    },

    resume: () => {
      const check = assertPaused();
      if (!check.ok) return check;

      controller.releaseGate();
      return { ok: true, value: undefined };
    },

    inspect: (tokens) => buildSnapshot(tokens),

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

      // Paginate arrays and maps
      const paginated = paginateData(value, offset, limit);

      return {
        ok: true,
        value: {
          token: token as string,
          data: paginated.data,
          totalItems: paginated.totalItems,
          offset,
          limit,
          hasMore: paginated.hasMore,
        },
      };
    },

    breakOn: (predicate: BreakpointPredicate, options?: BreakpointOptions): Breakpoint => {
      return controller.addBreakpoint(predicate, options);
    },

    removeBreakpoint: (bpId: BreakpointId): boolean => {
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
      return controller.eventBuffer().tail(limit);
    },

    createObserver: (): DebugObserver => {
      return createDebugObserver({
        agent,
        controller,
        debugSessionId: id,
        sessionId: snapshotSessionId,
      });
    },
  };

  return session;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

interface PaginatedResult {
  readonly data: unknown;
  readonly totalItems?: number;
  readonly hasMore: boolean;
}

function paginateData(value: unknown, offset: number, limit: number): PaginatedResult {
  if (Array.isArray(value)) {
    const slice = value.slice(offset, offset + limit);
    return {
      data: slice,
      totalItems: value.length,
      hasMore: offset + limit < value.length,
    };
  }

  if (value instanceof Map) {
    const entries = [...value.entries()];
    const slice = entries.slice(offset, offset + limit);
    return {
      data: Object.fromEntries(slice),
      totalItems: entries.length,
      hasMore: offset + limit < entries.length,
    };
  }

  // Scalars — no pagination
  return { data: value, hasMore: false };
}
