/**
 * Public factory: create-debug-attach.
 *
 * Creates a debug attachment for an agent. Manages single-attach semantics
 * with module-level tracking. Returns the debug session + middleware for
 * hot-wiring into the engine via dynamicMiddleware.
 */

import type {
  Agent,
  AgentId,
  DebugObserver,
  DebugSession,
  KoiError,
  KoiMiddleware,
  Result,
} from "@koi/core";
import { DEFAULT_EVENT_BUFFER_SIZE } from "./constants.js";
import type { DebugController } from "./debug-middleware.js";
import { createDebugMiddleware } from "./debug-middleware.js";
import { createDebugObserver } from "./debug-observer.js";
import { createDebugSession } from "./debug-session.js";
import { createEventRingBuffer } from "./event-ring-buffer.js";

// ---------------------------------------------------------------------------
// Module-level single-attach tracking
// ---------------------------------------------------------------------------

interface DebugBundle {
  readonly session: DebugSession;
  readonly controller: DebugController;
  readonly middleware: KoiMiddleware;
}

// let justified: module-level map for single-attach enforcement
const activeDebugSessions = new Map<string, DebugBundle>();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DebugAttachConfig {
  /** The agent to attach to. */
  readonly agent: Agent;
  /** Event buffer size. Default: 1000. */
  readonly bufferSize?: number | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface DebugAttachResult {
  /** The debug session for controlling the agent. */
  readonly session: DebugSession;
  /** The middleware to inject via dynamicMiddleware. */
  readonly middleware: KoiMiddleware;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Attach a debug session to an agent. Returns CONFLICT if already attached. */
export function createDebugAttach(config: DebugAttachConfig): Result<DebugAttachResult, KoiError> {
  const agentKey = config.agent.pid.id as string;

  // Single-attach check
  if (activeDebugSessions.has(agentKey)) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: `Agent ${agentKey} already has a debug session attached`,
        retryable: false,
      },
    };
  }

  const bufferSize = config.bufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
  const eventBuffer = createEventRingBuffer(bufferSize);
  const { middleware, controller } = createDebugMiddleware(eventBuffer);

  const session = createDebugSession({
    agent: config.agent,
    controller,
  });

  // Track the active session
  const bundle: DebugBundle = { session, controller, middleware };
  activeDebugSessions.set(agentKey, bundle);

  // Wrap detach to clean up tracking
  const originalDetach = session.detach;
  const wrappedSession: DebugSession = {
    ...session,
    detach: () => {
      activeDebugSessions.delete(agentKey);
      return originalDetach();
    },
  };

  return {
    ok: true,
    value: {
      session: wrappedSession,
      middleware,
    },
  };
}

/** Create a read-only observer for an agent's debug session. Returns NOT_FOUND if no session. */
export function createDebugObserve(
  agentId: AgentId,
  agent: Agent,
): Result<DebugObserver, KoiError> {
  const bundle = activeDebugSessions.get(agentId as string);
  if (bundle === undefined) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `No debug session for agent ${agentId as string}`,
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    value: createDebugObserver({
      agent,
      controller: bundle.controller,
      debugSessionId: bundle.session.id,
    }),
  };
}

/** Check if an agent has an active debug session. */
export function hasDebugSession(agentId: AgentId): boolean {
  return activeDebugSessions.has(agentId as string);
}

/**
 * Clear all debug sessions. Intended for testing cleanup only.
 * @internal
 */
export function clearAllDebugSessions(): void {
  for (const [, bundle] of activeDebugSessions) {
    bundle.controller.deactivate();
  }
  activeDebugSessions.clear();
}
