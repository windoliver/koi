/**
 * Session registry — keyed map of SessionId → AbortController for
 * programmatic interrupt. See docs/L2/interrupt.md and issue #1682.
 *
 * The registry holds AbortController references only — no transcript, no
 * engine state, no middleware state. Entries are auto-cleaned when a run's
 * finally block fires unregister().
 *
 * Single-process, in-memory. Cross-process coordination is out of scope.
 */

import type { RunId, SessionId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

export interface ActiveSession {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

export interface SessionRegistry {
  /**
   * Register a live run. Returns an unregister function that is safe to call
   * multiple times.
   *
   * Within a single runtime the engine's "running" guard ensures at most one
   * register() per sessionId at a time. When a single registry is shared
   * across multiple runtimes (e.g. a process-wide registry with per-session
   * agents), callers are responsible for ensuring sessionId uniqueness. A
   * duplicate register() throws CONFLICT (retryable) so hosts can handle
   * the collision — e.g. by unregistering the prior entry or routing the
   * interrupt differently.
   *
   * `runId` identifies this specific run invocation so `interrupt()` can
   * target it precisely and avoid cross-generation cancel hits (a late
   * cancel for a finished run A will not abort a subsequent run B on the
   * same sessionId when `expectedRunId` is supplied to `interrupt()`).
   *
   * `runSignal` should be the composite signal the run actually observes
   * (typically `AbortSignal.any([input.signal, controller.signal])`).
   * `interrupt()` and `isInterrupted()` read abort state from this signal,
   * so external aborts on `input.signal` are reflected correctly.
   */
  readonly register: (
    sessionId: SessionId,
    runId: RunId,
    controller: AbortController,
    runSignal: AbortSignal,
  ) => () => void;
  /** When `expectedRunId` is supplied, the registry requires the active
   *  entry's runId to match before aborting. Returns `false` on mismatch
   *  (cross-generation cancel) OR unknown session OR already-aborted. */
  readonly interrupt: (sessionId: SessionId, reason?: string, expectedRunId?: RunId) => boolean;
  readonly isInterrupted: (sessionId: SessionId) => boolean;
  readonly listActive: () => readonly ActiveSession[];
  /** Force-remove a stale entry for `sessionId`. Intended as a recovery
   *  escape hatch for hosts that leak or wedge runtimes, freeing the
   *  sessionId for a fresh registration.
   *
   *  Ownership guard — an entry is ONLY removed if at least one of:
   *    - `expectedRunId` is supplied AND matches the entry's runId
   *    - the entry's `runSignal` is already aborted (stale; the owner
   *      merely has not completed its cleanup yet)
   *  Live, unaborted runs cannot be evicted without proof of ownership.
   *  Returns `true` iff an entry was actually removed.
   *
   *  WARNING: this does NOT abort the controller or notify the owning
   *  runtime; it only evicts the registry entry. A wedged runtime may
   *  still be consuming resources and should be disposed separately. Use
   *  sparingly — the normal unregister path runs automatically in the
   *  generator's finally when the run completes. */
  readonly forceUnregister: (sessionId: SessionId, expectedRunId?: RunId) => boolean;
}

type RegistryEntry = {
  readonly runId: RunId;
  readonly controller: AbortController;
  readonly runSignal: AbortSignal;
};

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<SessionId, RegistryEntry>();

  function register(
    sessionId: SessionId,
    runId: RunId,
    controller: AbortController,
    runSignal: AbortSignal,
  ): () => void {
    if (entries.has(sessionId)) {
      // CONFLICT (retryable) — per-runtime the "running" guard prevents
      // duplicate register(); cross-runtime collisions are possible when
      // hosts share one registry across multiple runtimes that resume or
      // rebind the same persisted session id. Callers who need this
      // pattern should use per-runtime registries or coordinate session
      // id uniqueness before submission.
      throw KoiRuntimeError.from(
        "CONFLICT",
        `Session "${sessionId}" is already registered. Another runtime on this registry is tracking the same session — use per-runtime registries when resuming the same persisted session across runtimes, or ensure session ids are unique within a shared registry.`,
        { context: { sessionId } },
      );
    }
    const entry: RegistryEntry = { runId, controller, runSignal };
    entries.set(sessionId, entry);
    // let justified: mutable flag to make the returned unregister idempotent.
    let cleared = false;
    return () => {
      if (cleared) return;
      cleared = true;
      // Defensive: only clear if we're still the registered entry
      // for this sessionId. (A future re-registration could have overwritten
      // us; unlikely given the "running" guard, but cheap to check.)
      const current = entries.get(sessionId);
      if (current === entry) {
        entries.delete(sessionId);
      }
    };
  }

  function interrupt(sessionId: SessionId, reason?: string, expectedRunId?: RunId): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return false;
    if (expectedRunId !== undefined && entry.runId !== expectedRunId) return false;
    if (entry.runSignal.aborted) return false;
    entry.controller.abort(reason);
    return true;
  }

  function isInterrupted(sessionId: SessionId): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return false;
    return entry.runSignal.aborted;
  }

  function listActive(): readonly ActiveSession[] {
    return Array.from(entries.entries()).map(([sid, entry]) => ({
      sessionId: sid,
      runId: entry.runId,
    }));
  }

  function forceUnregister(sessionId: SessionId, expectedRunId?: RunId): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return false;
    // Allow removal only when the caller proves ownership via matching
    // runId, OR when the entry is already aborted (stale owner that
    // hasn't reached its cleanup path yet).
    const hasOwnershipToken = expectedRunId !== undefined && entry.runId === expectedRunId;
    const isStale = entry.runSignal.aborted;
    if (!hasOwnershipToken && !isStale) return false;
    entries.delete(sessionId);
    return true;
  }

  return { register, interrupt, isInterrupted, listActive, forceUnregister };
}
