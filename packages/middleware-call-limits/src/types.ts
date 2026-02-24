/**
 * Call limit types — store interface, exit behaviors, limit info.
 */

/**
 * Key-value counter store for tracking call counts.
 * Implementations may be sync (in-memory) or async (network).
 */
export interface CallLimitStore {
  readonly get: (key: string) => number | Promise<number>;
  readonly increment: (key: string) => number | Promise<number>;
  readonly reset: (key: string) => void | Promise<void>;
}

/** Exit behavior when model call limit is reached. Both throw RATE_LIMIT. */
export type ModelExitBehavior = "end" | "error";

/** Exit behavior when tool call limit is reached. */
export type ToolExitBehavior = "continue" | "end" | "error";

/** Info passed to onLimitReached callbacks. */
export interface LimitReachedInfo {
  readonly kind: "model" | "tool";
  readonly sessionId: string;
  readonly count: number;
  readonly limit: number;
  readonly toolId?: string | undefined;
}
