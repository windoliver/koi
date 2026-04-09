/**
 * Default lifecycle registration — registers explicit lifecycle entries.
 *
 * - local_shell: real lifecycle (Bun.spawn subprocess)
 * - local_agent, remote_agent, in_process_teammate, dream: unsupported stubs
 *
 * Each kind is listed explicitly so that adding a new TaskKindName to core
 * produces a build/test failure here rather than silently degrading to a
 * runtime stub. Consumers that need custom lifecycles can skip this and
 * register individually.
 */

import type { TaskKindName } from "@koi/core";
import type { TaskKindLifecycle, TaskRegistry } from "../task-registry.js";
import { createLocalShellLifecycle } from "./local-shell.js";
import { createUnsupportedLifecycle } from "./unsupported.js";

/** Explicitly listed unsupported kinds. Update when adding new TaskKindName values. */
const UNSUPPORTED_KINDS: readonly TaskKindName[] = [
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "dream",
];

/**
 * Register all known task kind lifecycles into the given registry.
 * Each kind is listed explicitly — adding a new kind to TASK_KIND_NAMES
 * without updating this list will surface as a missing-registration error
 * at startup or in tests, not a silent runtime stub.
 */
export function registerDefaultLifecycles(registry: TaskRegistry): void {
  // LocalShellLifecycle narrows config/state generics — widen to base
  // type for the generic registry. The double cast is needed because
  // TConfig is contravariant (unknown vs LocalShellConfig) and TState
  // is covariant (RuntimeTaskBase vs LocalShellTask). Runtime config
  // validation is the lifecycle's responsibility, not the registry's.
  registry.register(createLocalShellLifecycle() as unknown as TaskKindLifecycle);
  for (const kind of UNSUPPORTED_KINDS) {
    registry.register(createUnsupportedLifecycle(kind));
  }
}
