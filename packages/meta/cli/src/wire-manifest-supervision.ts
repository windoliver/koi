/**
 * Bridge between manifest.supervision and the TUI runtime.
 *
 * When a loaded `koi.yaml` declares `supervision:`, this helper:
 *   1. builds an in-memory AgentRegistry,
 *   2. registers the parent (the live runtime's agent) in it,
 *   3. wires the full supervision subsystem (ProcessTree + reconciler +
 *      CascadingTermination + ReconcileRunner) via `wireSupervision`,
 *   4. subscribes to registry transitions and pushes supervised child state
 *      into the TUI store so the `/agents` view can render them.
 *
 * The spawnChild delegate used here is INTENTIONALLY a stub that only
 * registers a RegistryEntry for each supervised child. It does NOT spawn a
 * child Koi runtime — a real child agent requires its own AgentManifest, and
 * the current koi.yaml schema only carries `name/restart/isolation` per
 * child. Running real supervised sub-agents end-to-end is tracked in #1944's
 * broader TUI daemon surface. This MVP exists so authors can declare
 * `supervision:` in koi.yaml and immediately see their declaration reflected
 * in the runtime + TUI rather than silently dropped at parse time.
 */

import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ChildSpec,
  SupervisionConfig,
} from "@koi/core";
import { agentId as makeAgentId } from "@koi/core";
import type { KoiRuntime, SupervisionWiring } from "@koi/engine";
import {
  createDispatchingSpawnChildFn,
  createInMemoryRegistry,
  createInProcessSpawnChildFn,
  wireSupervision,
} from "@koi/engine";

/**
 * Structurally typed SpawnChildFn — kept inline rather than importing from
 * `@koi/engine-reconcile` to avoid pulling that package into `@koi/cli`'s
 * dependency graph. Matches the shape consumed by createDispatchingSpawnChildFn.
 */
type SpawnChildFn = (
  parentId: AgentId,
  childSpec: ChildSpec,
  manifest: AgentManifest,
) => Promise<AgentId>;

export interface SupervisedChildSummary {
  readonly agentId: string;
  readonly childSpecName: string;
  readonly parentId: string;
  readonly phase: "created" | "running" | "terminated" | "waiting" | "suspended" | "idle";
}

export interface ManifestSupervisionHandle {
  readonly wiring: SupervisionWiring;
  /** Exposed for tests + future TUI queries; production callers should not
   *  mutate the registry directly. */
  readonly registry: AgentRegistry;
  readonly dispose: () => Promise<void>;
}

export interface WireManifestSupervisionOptions {
  readonly runtime: KoiRuntime;
  readonly supervisorManifestName: string;
  readonly supervision: SupervisionConfig;
  /**
   * Invoked whenever the set of live supervised children changes. The TUI
   * passes a handler that dispatches into the store; non-TUI callers can
   * log or ignore.
   */
  readonly onChange?: (children: readonly SupervisedChildSummary[]) => void;
  /**
   * Optional factory that produces a daemon-backed SpawnChildFn for
   * subprocess children. Receives the in-memory AgentRegistry created
   * here so the daemon adapter can register children under the same
   * registry the parent reconciler reads from.
   *
   * When undefined, subprocess children fall back to the in-process stub
   * (registers a placeholder entry; does not spawn). When provided AND
   * a child has a `command`, the dispatcher routes the child through the
   * daemon supervisor end-to-end. Children without `command` always use
   * the stub regardless of the factory, since the daemon adapter cannot
   * spawn without a command.
   */
  readonly subprocessSpawnFactory?: (agentRegistry: AgentRegistry) => SpawnChildFn;
}

export async function wireManifestSupervision(
  opts: WireManifestSupervisionOptions,
): Promise<ManifestSupervisionHandle> {
  const { runtime, supervisorManifestName, supervision, onChange } = opts;
  const registry = createInMemoryRegistry();
  const parentId: AgentId = runtime.agent.pid.id;

  // Compose the supervisor's L0 AgentManifest. The runtime itself was
  // built from the CLI-trimmed `ManifestConfig`, which doesn't carry the
  // full L0 shape; we rebuild the minimal manifest the reconciler needs
  // (name + supervision block is enough — no other fields are consulted).
  const supervisorManifest: AgentManifest = {
    name: supervisorManifestName,
    version: "1.0.0",
    model: { name: "supervisor" },
    supervision,
  };

  // Shared helper: inline registry-register for the stub path. Used
  // both by the in-process adapter and by the subprocess fallback when
  // the caller supplied no daemon factory or the child has no `command`.
  // Mints a fresh agent id, registers a placeholder entry in phase
  // "running", and returns the id. Does not actually spawn a runtime —
  // see file header for why.
  let spawnCounter = 0;
  const stubRegister = (parent: AgentId, childSpec: ChildSpec): AgentId => {
    spawnCounter += 1;
    const childId = makeAgentId(`${childSpec.name}-${spawnCounter}`);
    registry.register({
      agentId: childId,
      parentId: parent,
      status: {
        phase: "running",
        generation: 0,
        conditions: [],
        reason: { kind: "assembly_complete" },
        lastTransitionAt: Date.now(),
      },
      agentType: "worker",
      metadata: { childSpecName: childSpec.name },
      registeredAt: Date.now(),
      priority: 10,
    });
    return childId;
  };

  // In-process adapter — gates on isolation === "in-process" internally.
  const inProcessSpawn = createInProcessSpawnChildFn({
    registry,
    spawn: async (parent, childSpec) => stubRegister(parent, childSpec),
  });

  // Daemon-backed subprocess adapter, when the caller provided one.
  const daemonSpawnChild =
    opts.subprocessSpawnFactory !== undefined ? opts.subprocessSpawnFactory(registry) : undefined;

  // Subprocess dispatch wrapper: route to daemon when both a factory and a
  // command exist; otherwise fall back to the inline stub register so
  // legacy manifests (subprocess child without `command`) keep working.
  // Cannot use the in-process adapter here because it throws on
  // isolation !== "in-process".
  const subprocessSpawn: SpawnChildFn = async (parent, childSpec, manifest) => {
    if (daemonSpawnChild !== undefined && childSpec.command !== undefined) {
      return daemonSpawnChild(parent, childSpec, manifest);
    }
    return stubRegister(parent, childSpec);
  };

  const spawnChild = createDispatchingSpawnChildFn({
    inProcess: inProcessSpawn,
    subprocess: subprocessSpawn,
  });

  const wiring = wireSupervision({
    registry,
    manifests: new Map([[parentId, supervisorManifest]]),
    spawnChild,
  });

  // Register the parent AFTER wireSupervision so ProcessTree's watch
  // catches the `registered` event and enrolls the subtree. See
  // wire-supervision.ts for the ordering rationale.
  registry.register({
    agentId: parentId,
    status: {
      phase: "running",
      generation: 0,
      conditions: [],
      reason: { kind: "assembly_complete" },
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: { name: supervisorManifestName },
    registeredAt: Date.now(),
    priority: 10,
  });

  // Snapshot + push initial state whenever the registry mutates. The sweep
  // below drives the first spawn; we emit a snapshot on every registry
  // event so the TUI stays in sync.
  const emit = (): void => {
    if (onChange === undefined) return;
    const list = registry.list();
    if (list instanceof Promise) {
      // In-memory registry is synchronous; the type widens for async
      // implementations. Defensive branch — just ignore.
      return;
    }
    const summary: SupervisedChildSummary[] = [];
    for (const entry of list) {
      if (entry.parentId !== parentId) continue;
      // Terminated children are not deregistered by the reconciler; if we
      // included them, every restart (transient/permanent) would leave a
      // growing trail of stale rows in the TUI. Surface only live phases.
      if (entry.status.phase === "terminated") continue;
      summary.push({
        agentId: String(entry.agentId),
        childSpecName: String(entry.metadata.childSpecName ?? "(unnamed)"),
        parentId: String(parentId),
        phase: entry.status.phase,
      });
    }
    onChange(summary);
  };

  const unwatch = registry.watch(() => {
    emit();
  });

  // Drive the first reconcile. The reconciler's fast path enqueues on
  // registry events (parent registered above), but an explicit sweep makes
  // initial spawn synchronous from the caller's POV in most cases.
  wiring.reconcileRunner.sweep();
  // Push an initial empty snapshot so the TUI renders a "no children yet"
  // state instead of stale data from a previous session.
  emit();

  return {
    wiring,
    registry,
    dispose: async (): Promise<void> => {
      unwatch();
      await wiring[Symbol.asyncDispose]();
      await registry[Symbol.asyncDispose]();
    },
  };
}
