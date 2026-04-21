/**
 * In-process SpawnChildFn adapter for the SupervisionReconciler.
 *
 * Delegates to a caller-provided `spawn` function (typically wrapping
 * spawnChildAgent) and ensures `metadata.childSpecName` is set on the new
 * registry entry so the reconciler's metadata-based child match survives
 * restarts.
 *
 * Subprocess-isolated children land in 3b-5c — this adapter only serves
 * childSpec.isolation === "in-process" (the default).
 */

import type { AgentId, AgentManifest, AgentRegistry, ChildSpec } from "@koi/core";
import { DEFAULT_CHILD_ISOLATION } from "@koi/core";
import type { SpawnChildFn } from "@koi/engine-reconcile";
import { isPromise } from "@koi/engine-reconcile";

/**
 * Caller-provided in-process spawn. Typically constructed on top of
 * spawnChildAgent; takes the reconciler's (parentId, childSpec, manifest)
 * triple and returns the new agent id after the registry entry has been
 * committed. The adapter verifies metadata.childSpecName after the fact and
 * warns when missing.
 */
export type InProcessSpawnDelegate = (
  parentId: AgentId,
  childSpec: ChildSpec,
  manifest: AgentManifest,
) => Promise<AgentId>;

export interface CreateInProcessSpawnChildFnOptions {
  readonly registry: AgentRegistry;
  readonly spawn: InProcessSpawnDelegate;
}

export function createInProcessSpawnChildFn(
  opts: CreateInProcessSpawnChildFnOptions,
): SpawnChildFn {
  return async (parentId, childSpec, manifest) => {
    const isolation = childSpec.isolation ?? DEFAULT_CHILD_ISOLATION;
    if (isolation !== "in-process") {
      throw new Error(
        `in-process adapter cannot spawn childSpec.isolation="${isolation}" (child="${childSpec.name}"); subprocess adapter ships in 3b-5c`,
      );
    }

    const childId = await opts.spawn(parentId, childSpec, manifest);

    // Defensive: reconciler relies on metadata.childSpecName for robust
    // child-to-spec matching across restarts. If the delegate forgot to set
    // it, warn so callers know the position-based fallback will apply.
    const entry = opts.registry.lookup(childId);
    if (entry !== undefined && !isPromise(entry)) {
      if (entry.metadata.childSpecName !== childSpec.name) {
        console.warn(
          `[in-process-spawn-child-fn] delegate did not set metadata.childSpecName="${childSpec.name}" on child ${childId} — position-based fallback will apply`,
        );
      }
    }

    return childId;
  };
}
