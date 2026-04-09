/**
 * Unsupported lifecycle stub — fails closed for task kinds that are
 * defined in the type system but not yet implemented at runtime.
 *
 * Registering these stubs ensures that every valid TaskKindName has a
 * lifecycle entry, making the registry exhaustive. Callers get a clear
 * error message instead of a generic NOT_FOUND.
 */

import type { TaskItemId, TaskKindName } from "@koi/core";
import type { TaskOutputStream } from "../output-stream.js";
import type { TaskKindLifecycle } from "../task-registry.js";

/**
 * Symbol marker on lifecycle objects that marks them as unsupported stubs.
 * Using a Symbol prevents prototype-chain pollution from causing false positives.
 * TaskRunner checks this BEFORE mutating board state.
 */
export const UNSUPPORTED_LIFECYCLE_MARKER: unique symbol = Symbol.for("koi.unsupportedLifecycle");

/** @deprecated Use UNSUPPORTED_LIFECYCLE_MARKER (Symbol) instead. */
export const UNSUPPORTED_LIFECYCLE_MARKER_KEY = "__unsupportedLifecycle" as const;

/** Check whether a lifecycle is an unsupported stub (own-property Symbol check). */
export function isUnsupportedLifecycle(lifecycle: TaskKindLifecycle): boolean {
  return Object.hasOwn(lifecycle, UNSUPPORTED_LIFECYCLE_MARKER);
}

/**
 * Create a lifecycle that always rejects on start().
 * Use for task kinds that are recognized but not yet runnable.
 * Marked with UNSUPPORTED_LIFECYCLE_MARKER so TaskRunner can detect
 * and reject before board state mutation.
 */
export function createUnsupportedLifecycle(kind: TaskKindName): TaskKindLifecycle {
  const lifecycle: TaskKindLifecycle & Record<symbol, unknown> = {
    kind,
    start: (_taskId: TaskItemId, _output: TaskOutputStream): Promise<never> => {
      return Promise.reject(new Error(`Task kind "${kind}" is not yet implemented`));
    },
    stop: (): Promise<void> => Promise.resolve(),
  };
  lifecycle[UNSUPPORTED_LIFECYCLE_MARKER] = true;
  return lifecycle;
}
