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
// Types
// ---------------------------------------------------------------------------

interface DebugBundle {
  readonly agent: Agent;
  readonly session: DebugSession;
  readonly controller: DebugController;
  readonly middleware: KoiMiddleware;
}

export interface DebugAttachConfig {
  readonly agent: Agent;
  readonly bufferSize?: number | undefined;
}

export interface DebugAttachResult {
  readonly session: DebugSession;
  readonly middleware: KoiMiddleware;
}

// ---------------------------------------------------------------------------
// Module-level single-attach tracking
// ---------------------------------------------------------------------------

// let justified: module-level map enforcing single-attach per agent
const activeDebugSessions = new Map<string, DebugBundle>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Attach a debug session to an agent. Returns CONFLICT if already attached. */
export function createDebugAttach(config: DebugAttachConfig): Result<DebugAttachResult, KoiError> {
  const agentKey = config.agent.pid.id as string;

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
  if (!Number.isInteger(bufferSize) || bufferSize <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `bufferSize must be a positive integer, got ${String(bufferSize)}`,
        retryable: false,
      },
    };
  }
  const eventBuffer = createEventRingBuffer(bufferSize);
  const { middleware, controller } = createDebugMiddleware(eventBuffer);
  const session = createDebugSession({ agent: config.agent, controller });

  const bundle: DebugBundle = { agent: config.agent, session, controller, middleware };
  activeDebugSessions.set(agentKey, bundle);

  // Wrap detach to clean up module-level tracking
  const originalDetach = session.detach;
  const wrappedSession: DebugSession = {
    ...session,
    detach: () => {
      activeDebugSessions.delete(agentKey);
      return originalDetach();
    },
  };

  return { ok: true, value: { session: wrappedSession, middleware } };
}

/** @internal Use session.createObserver() instead. Kept for testing convenience only. */
export function createDebugObserve(agentId: AgentId): Result<DebugObserver, KoiError> {
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
      agent: bundle.agent,
      controller: bundle.controller,
      debugSessionId: bundle.session.id,
    }),
  };
}

/** Check if an agent has an active debug session. */
export function hasDebugSession(agentId: AgentId): boolean {
  return activeDebugSessions.has(agentId as string);
}

/** Clear all debug sessions. For testing cleanup only. */
export function clearAllDebugSessions(): void {
  for (const [, bundle] of activeDebugSessions) {
    bundle.controller.deactivate();
  }
  activeDebugSessions.clear();
}
