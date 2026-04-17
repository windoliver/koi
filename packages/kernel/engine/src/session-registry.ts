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

import type { SessionId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

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
   * `runSignal` should be the composite signal the run actually observes
   * (typically `AbortSignal.any([input.signal, controller.signal])`).
   * `interrupt()` and `isInterrupted()` read abort state from this signal,
   * so external aborts on `input.signal` are reflected correctly.
   */
  readonly register: (
    sessionId: SessionId,
    controller: AbortController,
    runSignal: AbortSignal,
  ) => () => void;
  readonly interrupt: (sessionId: SessionId, reason?: string) => boolean;
  readonly isInterrupted: (sessionId: SessionId) => boolean;
  readonly listActive: () => readonly SessionId[];
}

type RegistryEntry = {
  readonly controller: AbortController;
  readonly runSignal: AbortSignal;
};

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<SessionId, RegistryEntry>();

  function register(
    sessionId: SessionId,
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
    const entry: RegistryEntry = { controller, runSignal };
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

  function interrupt(sessionId: SessionId, reason?: string): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return false;
    if (entry.runSignal.aborted) return false;
    entry.controller.abort(reason);
    return true;
  }

  function isInterrupted(sessionId: SessionId): boolean {
    const entry = entries.get(sessionId);
    if (entry === undefined) return false;
    return entry.runSignal.aborted;
  }

  function listActive(): readonly SessionId[] {
    return [...entries.keys()];
  }

  return { register, interrupt, isInterrupted, listActive };
}
