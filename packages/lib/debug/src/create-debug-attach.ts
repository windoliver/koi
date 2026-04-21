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
  /** Tears down session + controller + cancels termination watcher. */
  readonly teardown: (reason: "user" | "agent_terminated" | "replaced") => void;
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
    // Any live bundle is a CONFLICT — even if caller passes a different Agent
    // object with the same pid.id (could be cross-runtime namespace collision;
    // refuse to evict rather than tear down the wrong session). Callers must
    // explicitly detach the existing session before re-attaching.
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
    // Safe to clean up: either agent terminated, or controller already deactivated.
    const replacementReason: "user" | "agent_terminated" | "replaced" = agentTerminated
      ? "agent_terminated"
      : "replaced";
    existingBundle.teardown(replacementReason);
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

  // Agent-termination watcher: polls agent.state so a paused gate is always
  // released even if no one explicitly calls session.detach(). Without this,
  // an external agent kill while paused would hang the turn runner forever.
  let tornDown = false;
  const teardown = (reason: "user" | "agent_terminated" | "replaced"): void => {
    if (tornDown) return;
    tornDown = true;
    clearInterval(terminationWatcher);
    detachWithReason(reason);
  };

  const terminationWatcher: ReturnType<typeof setInterval> = setInterval(() => {
    if (config.agent.state === "terminated") {
      if (activeDebugSessions.get(agentKey) === bundle) {
        teardown("agent_terminated");
        activeDebugSessions.delete(agentKey);
      } else {
        clearInterval(terminationWatcher);
      }
    }
  }, AGENT_TERMINATION_POLL_MS);
  if (typeof terminationWatcher === "object" && "unref" in terminationWatcher) {
    (terminationWatcher as { unref: () => void }).unref();
  }

  const bundle: DebugBundle = {
    agent: config.agent,
    session,
    controller,
    middleware,
    teardown,
  };
  activeDebugSessions.set(agentKey, bundle);

  // Wrap detach so the public session.detach() path also clears the watcher
  const wrappedSession: DebugSession = {
    ...session,
    detach: () => {
      teardown("user");
      activeDebugSessions.delete(agentKey);
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
    bundle.teardown("agent_terminated");
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
    bundle.teardown("agent_terminated");
    activeDebugSessions.delete(key);
    return false;
  }
  if (!bundle.controller.isActive()) {
    bundle.teardown("replaced");
    activeDebugSessions.delete(key);
    return false;
  }
  return true;
}

/** Clear all debug sessions. For testing cleanup only. */
export function clearAllDebugSessions(): void {
  for (const [, bundle] of activeDebugSessions) {
    bundle.teardown("replaced");
  }
  activeDebugSessions.clear();
}
