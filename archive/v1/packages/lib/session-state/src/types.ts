/**
 * Per-session state management types.
 */

/** Manages per-session state keyed by session ID. */
export interface SessionStateManager<T> {
  /** Returns existing state or creates it via the factory. */
  readonly getOrCreate: (sessionId: string) => T;
  /** Returns existing state or undefined if no state exists for this session. */
  readonly get: (sessionId: string) => T | undefined;
  /** Applies an immutable update to existing state. No-op if session not found. */
  readonly update: (sessionId: string, fn: (state: T) => T) => void;
  /** Removes state for a session. Returns false if session was not found. */
  readonly delete: (sessionId: string) => boolean;
  /** Removes all session state. */
  readonly clear: () => void;
  /** Number of active sessions. */
  readonly size: number;
}

/** Configuration for session state eviction. */
export interface SessionStateConfig {
  /** Maximum number of sessions to track. FIFO eviction when exceeded. Default: 1000. */
  readonly maxSessions?: number | undefined;
  /** Called when a session is evicted due to maxSessions. */
  readonly onEvict?: ((sessionId: string) => void) | undefined;
}
