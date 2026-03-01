/**
 * Internal types for the debug package.
 */

import type { BreakpointId, DebugState } from "@koi/core";

/** Mutable internal debug state. */
export interface InternalDebugState {
  /** Current state. */
  state: DebugState;
  /** Current turn index. */
  turnIndex: number;
  /** Step counter for step-through mode. */
  stepsRemaining: number;
}

/** Gate control for pausing the engine loop. */
export interface GateControl {
  /** The promise that blocks the engine loop when paused. */
  readonly promise: Promise<void>;
  /** Release the gate to resume execution. */
  readonly release: () => void;
}

/** Create a promise-based gate for blocking the engine loop. */
export function createGate(): GateControl {
  // let justified: resolve function captured from promise constructor
  let releaseFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  if (releaseFn === undefined) {
    throw new Error("Promise constructor did not execute synchronously");
  }
  return { promise, release: releaseFn };
}

/** Map from breakpoint ID to removal flag for auto-remove on predicate error. */
export interface BreakpointEntry {
  readonly id: BreakpointId;
  readonly predicate: import("@koi/core").BreakpointPredicate;
  readonly once: boolean;
  readonly label?: string | undefined;
}
