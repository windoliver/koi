/**
 * Call limits middleware — types.
 */

export type ToolExitBehavior = "continue" | "error";
export type ModelExitBehavior = "error";

export interface IncrementIfBelowResult {
  readonly allowed: boolean;
  /** Counter value AFTER the operation (whether or not it was incremented). */
  readonly current: number;
}

export interface CallLimitStore {
  readonly get: (key: string) => number;
  readonly increment: (key: string) => number;
  readonly decrement: (key: string) => number;
  readonly reset: (key: string) => void;
  /** Atomic check-and-increment: increments only if `current < limit`. */
  readonly incrementIfBelow: (key: string, limit: number) => IncrementIfBelowResult;
}

export type LimitReachedInfo =
  | {
      readonly kind: "tool";
      readonly sessionId: string;
      readonly toolId: string;
      readonly count: number;
      readonly limit: number;
    }
  | {
      readonly kind: "model";
      readonly sessionId: string;
      readonly count: number;
      readonly limit: number;
    };
