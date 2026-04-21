/**
 * wireSupervision — compose ProcessTree + SupervisionReconciler +
 * CascadingTermination + ReconcileRunner in the one order that works.
 *
 * Called by createKoi when the loaded manifest has `supervision?` set.
 * Returns an AsyncDisposable bundle that owns lifecycle of the 4 components.
 *
 * Decision D5 (spec): strict registration order is
 *   ProcessTree → SupervisionReconciler → CascadingTermination → register both → start
 * so that CascadingTermination's isSupervised callback always sees the
 * reconciler's childMap before the first registry.watch event flows.
 *
 * Decision D4 (spec): ReconcileRunner configured with
 * driftCheckIntervalMs = 30_000 — event-driven fast path plus a 30s safety
 * net against lost events.
 */

import type { AgentManifest, AgentRegistry } from "@koi/core";
import {
  type CascadingTermination,
  type Clock,
  createCascadingTermination,
  createProcessTree,
  createReconcileRunner,
  createSupervisionReconciler,
  type ProcessTree,
  type ReconcileRunner,
  type SpawnChildFn,
  type SupervisionReconciler,
} from "@koi/engine-reconcile";

const DEFAULT_DRIFT_CHECK_INTERVAL_MS = 30_000;

export interface WireSupervisionOptions {
  readonly registry: AgentRegistry;
  readonly manifests: ReadonlyMap<string, AgentManifest>;
  readonly spawnChild: SpawnChildFn;
  readonly clock?: Clock;
  /** Override drift-sweep interval. Default 30_000 ms. */
  readonly driftCheckIntervalMs?: number;
}

export interface SupervisionWiring extends AsyncDisposable {
  readonly processTree: ProcessTree;
  readonly reconciler: SupervisionReconciler;
  readonly cascading: CascadingTermination;
  readonly reconcileRunner: ReconcileRunner;
}

export function wireSupervision(opts: WireSupervisionOptions): SupervisionWiring {
  // 1. ProcessTree first — subscribes to registry.watch; all downstream
  //    components rely on its parent/child map being populated.
  const processTree = createProcessTree(opts.registry);

  // 2. SupervisionReconciler — consumes processTree + spawnChild.
  const reconciler = createSupervisionReconciler({
    registry: opts.registry,
    processTree,
    spawnChild: opts.spawnChild,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });

  // 3. CascadingTermination — consumes reconciler.isSupervised. Constructed
  //    AFTER reconciler so the callback is wired, not a dangling reference.
  const cascading = createCascadingTermination(opts.registry, processTree, reconciler.isSupervised);

  // 4. ReconcileRunner — event-driven + 30s drift sweep (D4).
  const reconcileRunner = createReconcileRunner({
    registry: opts.registry,
    manifests: opts.manifests,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    config: {
      driftCheckIntervalMs: opts.driftCheckIntervalMs ?? DEFAULT_DRIFT_CHECK_INTERVAL_MS,
    },
  });

  reconcileRunner.register(reconciler);
  reconcileRunner.start();

  // 5. Supervisor-aware watch bridge. The reconcile-runner's built-in watch
  //    only enqueues the transitioned agent itself — so a child "terminated"
  //    event reaches the reconciler against the child, not the supervisor.
  //    The child has no manifest.supervision, so supervision never fires on
  //    the fast path; supervisors would only react via the 30s drift sweep.
  //    Bridge: on every transition, look up the agent's parent in
  //    ProcessTree and sweep to re-enqueue running agents (including the
  //    parent supervisor). This keeps supervision reactions event-driven
  //    without requiring the reconciler itself to be supervisor-aware.
  const unwatchSupervisorBridge = opts.registry.watch((event) => {
    if (event.kind !== "transitioned") return;
    const parent = processTree.parentOf(event.agentId);
    if (parent === undefined) return;
    // A supervisor only reacts when one of its supervised children
    // transitions — skip unrelated parents cheaply.
    if (!reconciler.isSupervised(event.agentId)) return;
    reconcileRunner.sweep();
  });

  let disposed = false;

  return {
    processTree,
    reconciler,
    cascading,
    reconcileRunner,
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Dispose in reverse construction order so later components (which
      // may hold handles to earlier ones) release first.
      unwatchSupervisorBridge();
      await reconcileRunner[Symbol.asyncDispose]();
      await cascading[Symbol.asyncDispose]();
      await reconciler[Symbol.asyncDispose]();
      await processTree[Symbol.asyncDispose]();
    },
  };
}
