/**
 * Factory for per-session state managers.
 *
 * Middleware authors use this instead of module-scoped `let` variables
 * to isolate state per session and prevent cross-session leaks.
 */

import type { SessionStateConfig, SessionStateManager } from "./types.js";

const DEFAULT_MAX_SESSIONS = 1000;

/**
 * Creates a session state manager that lazily initializes per-session state.
 *
 * @param factory - Called to create initial state for a new session.
 * @param config  - Optional eviction configuration.
 */
export function createSessionState<T>(
  factory: () => T,
  config?: SessionStateConfig,
): SessionStateManager<T> {
  const maxSessions = config?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const onEvict = config?.onEvict;
  const sessions = new Map<string, T>();

  function evictOldest(): void {
    // Map iterates in insertion order — first key is oldest (FIFO)
    const oldest = sessions.keys().next();
    if (!oldest.done) {
      const oldestId = oldest.value;
      sessions.delete(oldestId);
      onEvict?.(oldestId);
    }
  }

  return {
    getOrCreate(sessionId: string): T {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) return existing;

      // Call factory first — if it throws, no eviction or mutation occurs
      const state = factory();

      if (sessions.size >= maxSessions) {
        evictOldest();
      }

      sessions.set(sessionId, state);
      return state;
    },

    get(sessionId: string): T | undefined {
      return sessions.get(sessionId);
    },

    update(sessionId: string, fn: (state: T) => T): void {
      const existing = sessions.get(sessionId);
      if (existing === undefined) return;
      sessions.set(sessionId, fn(existing));
    },

    delete(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },

    clear(): void {
      sessions.clear();
    },

    get size(): number {
      return sessions.size;
    },
  };
}
