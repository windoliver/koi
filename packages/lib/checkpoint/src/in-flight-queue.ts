/**
 * In-flight queue — implements #1625 design review issue 11A.
 *
 * The contract: rewind requests received during a tool call are queued and
 * fire when the engine returns to "idle" (no tool currently running for that
 * session). This sidesteps the per-tool cancellation problem (Bash
 * subprocesses can't be safely cancelled mid-syscall) and keeps rewind
 * semantics aligned with turn boundaries.
 *
 * The implementation tracks engine state via two maps:
 *
 *   - `engineState: Map<SessionId, "idle" | "tool-running">`
 *     Updated by `wrapToolCall`: set to running on entry, idle in finally.
 *   - `idleWaiters: Map<SessionId, Array<() => void>>`
 *     Promises that resolve when the session next becomes idle.
 *
 * Multiple concurrent rewind requests for the same session serialize via a
 * promise chain (`lastRewind`) — each rewind awaits the prior rewind's
 * completion before reading state and dispatching its own restore. This
 * keeps the chain in a consistent state across overlapping requests.
 */

import type { SessionId } from "@koi/core";

export type EngineState = "idle" | "tool-running";

/**
 * Engine state tracker. Created per `Checkpoint` instance.
 */
export interface InFlightTracker {
  /** Get the current engine state for a session. Defaults to "idle". */
  readonly getState: (sessionId: SessionId) => EngineState;
  /** Mark a session as having a tool currently running. */
  readonly enterTool: (sessionId: SessionId) => void;
  /**
   * Mark the tool as finished. Triggers any pending `waitForIdle` waiters
   * for this session.
   */
  readonly exitTool: (sessionId: SessionId) => void;
  /**
   * Resolves immediately if the session is idle. Otherwise resolves the
   * next time `exitTool` is called for this session.
   */
  readonly waitForIdle: (sessionId: SessionId) => Promise<void>;
}

/**
 * Create a fresh in-flight tracker. State is per-instance — a single
 * `Checkpoint` instance shares one tracker across capture and rewind paths.
 */
export function createInFlightTracker(): InFlightTracker {
  const engineState = new Map<SessionId, EngineState>();
  const idleWaiters = new Map<SessionId, Array<() => void>>();

  function getState(sessionId: SessionId): EngineState {
    return engineState.get(sessionId) ?? "idle";
  }

  function enterTool(sessionId: SessionId): void {
    engineState.set(sessionId, "tool-running");
  }

  function exitTool(sessionId: SessionId): void {
    engineState.set(sessionId, "idle");
    const waiters = idleWaiters.get(sessionId);
    if (waiters !== undefined && waiters.length > 0) {
      idleWaiters.delete(sessionId);
      for (const w of waiters) w();
    }
  }

  function waitForIdle(sessionId: SessionId): Promise<void> {
    if (getState(sessionId) === "idle") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const list = idleWaiters.get(sessionId) ?? [];
      list.push(resolve);
      idleWaiters.set(sessionId, list);
    });
  }

  return { getState, enterTool, exitTool, waitForIdle };
}

/**
 * Per-session serializer for rewind operations. New rewinds wait for the
 * prior rewind to finish before reading state and dispatching, so concurrent
 * `rewind()` calls run sequentially per session.
 *
 * Errors from a prior rewind do NOT prevent subsequent rewinds from
 * running — we `.catch(() => undefined)` so the chain continues on failure.
 */
export interface RewindSerializer {
  /**
   * Schedule `task` to run after any prior task for this session has
   * settled, AND after the engine returns to idle for this session.
   */
  readonly schedule: <T>(sessionId: SessionId, task: () => Promise<T>) => Promise<T>;
}

export function createRewindSerializer(tracker: InFlightTracker): RewindSerializer {
  const lastRewind = new Map<SessionId, Promise<unknown>>();

  function schedule<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> {
    const prior = lastRewind.get(sessionId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined) // never block on a prior failure
      .then(() => tracker.waitForIdle(sessionId))
      .then(() => task());
    lastRewind.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  return { schedule };
}
