import type { BreakpointId, BreakpointPredicate } from "@koi/core";

/** Gate control for pausing the engine loop. */
export interface GateControl {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

/** Create a promise-based gate for blocking the engine loop. */
export function createGate(): GateControl {
  // let justified: resolve fn captured from promise constructor
  let releaseFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  if (releaseFn === undefined) {
    throw new Error("Promise constructor did not execute synchronously");
  }
  return { promise, release: releaseFn };
}

/** Internal entry tracking a registered breakpoint. */
export interface BreakpointEntry {
  readonly id: BreakpointId;
  readonly predicate: BreakpointPredicate;
  readonly once: boolean;
  readonly label?: string | undefined;
}
