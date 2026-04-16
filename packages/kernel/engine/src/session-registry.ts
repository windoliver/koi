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
  readonly register: (sessionId: SessionId, controller: AbortController) => () => void;
  readonly interrupt: (sessionId: SessionId, reason?: string) => boolean;
  readonly isInterrupted: (sessionId: SessionId) => boolean;
  readonly listActive: () => readonly SessionId[];
}

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<SessionId, AbortController>();

  function register(sessionId: SessionId, controller: AbortController): () => void {
    if (entries.has(sessionId)) {
      throw KoiRuntimeError.from(
        "INTERNAL",
        `Session "${sessionId}" is already registered. The engine's "running" guard should prevent concurrent runs; a duplicate register() here indicates a lifecycle bug.`,
        { context: { sessionId } },
      );
    }
    entries.set(sessionId, controller);
    // let justified: mutable flag to make the returned unregister idempotent.
    let cleared = false;
    return () => {
      if (cleared) return;
      cleared = true;
      // Defensive: only clear if we're still the registered controller
      // for this sessionId. (A future re-registration could have overwritten
      // us; unlikely given the "running" guard, but cheap to check.)
      const current = entries.get(sessionId);
      if (current === controller) {
        entries.delete(sessionId);
      }
    };
  }

  function interrupt(sessionId: SessionId, reason?: string): boolean {
    const controller = entries.get(sessionId);
    if (controller === undefined) return false;
    if (controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  function isInterrupted(sessionId: SessionId): boolean {
    const controller = entries.get(sessionId);
    if (controller === undefined) return false;
    return controller.signal.aborted;
  }

  function listActive(): readonly SessionId[] {
    return [...entries.keys()];
  }

  return { register, interrupt, isInterrupted, listActive };
}
