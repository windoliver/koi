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
import { createDebugSessionInternal } from "./debug-session.js";
import { createEventRingBuffer } from "./event-ring-buffer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DebugBundle {
  readonly agent: Agent;
  readonly session: DebugSession;
  readonly controller: DebugController;
  readonly middleware: KoiMiddleware;
  readonly detachWithReason: (reason: "user" | "agent_terminated" | "replaced") => void;
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

  const existingBundle = activeDebugSessions.get(agentKey);
  if (existingBundle !== undefined) {
    const agentTerminated = existingBundle.agent.state === "terminated";
    const controllerLive = existingBundle.controller.isActive();
    if (controllerLive && !agentTerminated) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Agent ${agentKey} already has a debug session attached`,
          retryable: false,
        },
      };
    }
    // Stale: agent terminated or controller deactivated without explicit detach — clean up.
    // Call session.detach() so the old handle is uniformly unusable (not just controller).
    const replacementReason: "user" | "agent_terminated" | "replaced" = agentTerminated
      ? "agent_terminated"
      : "replaced";
    existingBundle.detachWithReason(replacementReason);
    activeDebugSessions.delete(agentKey);
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
  const { session, detachWithReason } = createDebugSessionInternal({
    agent: config.agent,
    controller,
  });

  const bundle: DebugBundle = {
    agent: config.agent,
    session,
    controller,
    middleware,
    detachWithReason,
  };
  activeDebugSessions.set(agentKey, bundle);

  // Agent-termination watcher: polls agent.state so a paused gate is always
  // released even if no one explicitly calls session.detach(). Without this,
  // an external agent kill while paused would hang the turn runner forever.
  const terminationWatcher: ReturnType<typeof setInterval> = setInterval(() => {
    if (config.agent.state === "terminated") {
      clearInterval(terminationWatcher);
      if (activeDebugSessions.get(agentKey) === bundle) {
        detachWithReason("agent_terminated");
        activeDebugSessions.delete(agentKey);
      }
    }
  }, AGENT_TERMINATION_POLL_MS);
  // Don't keep the process alive just for the watcher (Node.js / Bun convention)
  if (typeof terminationWatcher === "object" && "unref" in terminationWatcher) {
    (terminationWatcher as { unref: () => void }).unref();
  }

  // Wrap detach to clean up module-level tracking + stop the watcher
  const originalDetach = session.detach;
  const wrappedSession: DebugSession = {
    ...session,
    detach: () => {
      clearInterval(terminationWatcher);
      activeDebugSessions.delete(agentKey);
      return originalDetach();
    },
  };

  return { ok: true, value: { session: wrappedSession, middleware } };
}

const AGENT_TERMINATION_POLL_MS = 250;

/** @internal Use session.createObserver() instead. Kept for testing convenience only. */
export function createDebugObserve(agentId: AgentId): Result<DebugObserver, KoiError> {
  const key = agentId as string;
  const bundle = activeDebugSessions.get(key);
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
  if (bundle.agent.state === "terminated") {
    bundle.detachWithReason("agent_terminated");
    activeDebugSessions.delete(key);
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Debug session for agent ${agentId as string} was revoked (agent terminated)`,
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

/** Check if an agent has an active debug session. Eagerly cleans up stale/terminated entries. */
export function hasDebugSession(agentId: AgentId): boolean {
  const key = agentId as string;
  const bundle = activeDebugSessions.get(key);
  if (bundle === undefined) return false;
  if (bundle.agent.state === "terminated") {
    bundle.detachWithReason("agent_terminated");
    activeDebugSessions.delete(key);
    return false;
  }
  if (!bundle.controller.isActive()) {
    bundle.detachWithReason("replaced");
    activeDebugSessions.delete(key);
    return false;
  }
  return true;
}

/** Clear all debug sessions. For testing cleanup only. */
export function clearAllDebugSessions(): void {
  for (const [, bundle] of activeDebugSessions) {
    bundle.controller.deactivate();
  }
  activeDebugSessions.clear();
}
