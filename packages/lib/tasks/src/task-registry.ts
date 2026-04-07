/**
 * Task kind registry — maps TaskKindName to lifecycle implementations.
 *
 * The registry is a simple Map wrapper. Lifecycle implementations are
 * registered once at startup, then looked up by kind when tasks are started.
 */

import type { TaskItemId, TaskKindName } from "@koi/core";
import type { TaskOutputStream } from "./output-stream.js";
import type { RuntimeTaskBase } from "./task-kinds.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle handler for a task kind.
 *
 * Generic over config and state for type-safe implementations.
 * The registry stores the base type; concrete callers can narrow.
 */
export interface TaskKindLifecycle<
  TConfig = unknown,
  TState extends RuntimeTaskBase = RuntimeTaskBase,
> {
  readonly kind: TaskKindName;
  /** Start a task. Receives a pre-created output stream from the runner. */
  readonly start: (taskId: TaskItemId, output: TaskOutputStream, config: TConfig) => Promise<TState>;
  /** Stop a running task and clean up resources. */
  readonly stop: (state: TState) => Promise<void>;
}

/** Registry of task kind lifecycle implementations. */
export interface TaskRegistry {
  /** Register a lifecycle. Throws on duplicate kind. */
  readonly register: (lifecycle: TaskKindLifecycle) => void;
  /** Look up lifecycle by kind. */
  readonly get: (kind: TaskKindName) => TaskKindLifecycle | undefined;
  /** Check if a kind is registered. */
  readonly has: (kind: TaskKindName) => boolean;
  /** All registered kind names. */
  readonly kinds: () => readonly TaskKindName[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a task kind registry. */
export function createTaskRegistry(): TaskRegistry {
  const lifecycles = new Map<TaskKindName, TaskKindLifecycle>();

  const register = (lifecycle: TaskKindLifecycle): void => {
    if (lifecycles.has(lifecycle.kind)) {
      throw new Error(`Task kind "${lifecycle.kind}" is already registered`);
    }
    lifecycles.set(lifecycle.kind, lifecycle);
  };

  const get = (kind: TaskKindName): TaskKindLifecycle | undefined => {
    return lifecycles.get(kind);
  };

  const has = (kind: TaskKindName): boolean => {
    return lifecycles.has(kind);
  };

  const kinds = (): readonly TaskKindName[] => {
    return [...lifecycles.keys()];
  };

  return { register, get, has, kinds };
}
