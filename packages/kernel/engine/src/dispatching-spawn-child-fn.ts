/**
 * Dispatching `SpawnChildFn` — routes supervised children to a per-isolation
 * adapter. In-process and subprocess children can coexist under the same
 * supervisor; the reconciler doesn't know (or care) which isolation each
 * child uses. This wrapper consumes `childSpec.isolation` and delegates.
 *
 * When `subprocess` is omitted and a child requests subprocess isolation,
 * the dispatcher throws — fail loud rather than silently fall back to
 * in-process, which would defeat the whole point of declaring
 * `isolation: "subprocess"` in the manifest.
 */

import type { AgentManifest, ChildSpec } from "@koi/core";
import { DEFAULT_CHILD_ISOLATION } from "@koi/core";
import type { SpawnChildFn } from "@koi/engine-reconcile";

export interface CreateDispatchingSpawnChildFnOptions {
  readonly inProcess: SpawnChildFn;
  /**
   * Subprocess adapter. Typically `createDaemonSpawnChildFn` from
   * `@koi/daemon`. Structurally typed so this module stays L1-safe —
   * it does not import from the daemon package.
   */
  readonly subprocess?: SpawnChildFn;
}

export function createDispatchingSpawnChildFn(
  opts: CreateDispatchingSpawnChildFnOptions,
): SpawnChildFn {
  return (parentId, childSpec: ChildSpec, manifest: AgentManifest) => {
    const isolation = childSpec.isolation ?? DEFAULT_CHILD_ISOLATION;
    if (isolation === "subprocess") {
      if (opts.subprocess === undefined) {
        throw new Error(
          `dispatching SpawnChildFn: child="${childSpec.name}" declares isolation="subprocess" ` +
            `but no subprocess adapter was provided. Supply opts.subprocess (e.g. createDaemonSpawnChildFn) ` +
            `or change the childSpec to isolation="in-process".`,
        );
      }
      return opts.subprocess(parentId, childSpec, manifest);
    }
    return opts.inProcess(parentId, childSpec, manifest);
  };
}
