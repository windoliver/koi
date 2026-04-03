/**
 * Session revocation store — in-memory Set<SessionId>.
 *
 * Session-scoped revocation (Issue 3): tokens carry sessionId in their scope.
 * When a session is terminated, all tokens with that sessionId become invalid.
 * This is the "parent death = all child tokens invalid" invariant.
 *
 * The store is populated by engine lifecycle events (session termination).
 * It is passed into VerifyContext.activeSessionIds during verification.
 * A token whose scope.sessionId is NOT in activeSessionIds is denied.
 */

import type { SessionId } from "@koi/core";

/**
 * In-memory session revocation store.
 *
 * Exposes a snapshot() method so the current set can be passed to
 * VerifyContext.activeSessionIds without exposing the mutable store.
 */
export interface SessionRevocationStore {
  /** Mark a session as active (call when session starts). */
  readonly add: (sessionId: SessionId) => void;
  /** Remove a session from active set (call when session terminates). */
  readonly delete: (sessionId: SessionId) => void;
  /** Check if a session is currently active. */
  readonly has: (sessionId: SessionId) => boolean;
  /** Return an immutable snapshot of the currently active session IDs. */
  readonly snapshot: () => ReadonlySet<SessionId>;
}

/**
 * Creates an in-memory session revocation store.
 *
 * The store is a plain Set<SessionId>. snapshot() returns a frozen copy
 * to ensure VerifyContext.activeSessionIds is immutable.
 */
export function createSessionRevocationStore(): SessionRevocationStore {
  const active = new Set<SessionId>();

  return {
    add(sessionId: SessionId): void {
      active.add(sessionId);
    },
    delete(sessionId: SessionId): void {
      active.delete(sessionId);
    },
    has(sessionId: SessionId): boolean {
      return active.has(sessionId);
    },
    snapshot(): ReadonlySet<SessionId> {
      return new Set(active);
    },
  };
}
