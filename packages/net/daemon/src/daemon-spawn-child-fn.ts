/**
 * Daemon-backed `SpawnChildFn` — companion to the in-process adapter
 * (`@koi/engine` / createInProcessSpawnChildFn). Accepts supervised children
 * with `childSpec.isolation === "subprocess"`, routes them through a live
 * `Supervisor`, and maintains both the `BackgroundSessionRegistry` (for
 * operator observability via `koi bg ps`) and the parent-visible
 * `AgentRegistry` (so the supervision reconciler sees the child lifecycle
 * through its usual level-triggered reconcile loop).
 *
 * Wiring sketch:
 *
 *   parent reconciler --(spawnChild)--> createDaemonSpawnChildFn
 *                                              │
 *                                              ├─> sessionRegistry.register
 *                                              ├─> agentRegistry.register (phase=created)
 *                                              ├─> bridge.mapWorker(workerId, agentId)
 *                                              └─> supervisor.start(...)
 *                                                     │
 *                                                     ▼
 *                                              subprocess live
 *                                                     │
 *                                                     ▼
 *                                        supervisor.watchAll() events
 *                                              │                        │
 *                            attachRegistry ◀──┘                        └─▶ attachAgentRegistry
 *                           (BackgroundSessionRegistry)                      (AgentRegistry → transitions)
 *                                                                            │
 *                                                                            ▼
 *                                                           parent reconciler observes terminated,
 *                                                           restarts per childSpec.restart policy
 *
 * Restart semantics: on each restart the reconciler calls this function
 * again; we mint a FRESH `agentId` and `workerId` per attempt. Reusing the
 * same ids would require clearing terminal state on the AgentRegistry
 * entry, which conflicts with the one-way `created → running → terminated`
 * phase machine. Unique ids keep the lifecycle linear and the ProcessTree
 * parent/child edges correct across respawns.
 */

import type { AgentId, AgentManifest, AgentRegistry, ChildSpec } from "@koi/core";
import { agentId as makeAgentId } from "@koi/core";
import type { BackgroundSessionRegistry, Supervisor, WorkerBackendKind } from "@koi/core/daemon";
import { workerId as makeWorkerId } from "@koi/core/daemon";
import type { AgentRegistryBridge } from "./agent-registry-bridge.js";

/**
 * Build the actual OS command to spawn for a supervised child. Callers own
 * the worker bootstrap: this package makes no assumption about how the
 * child agent runtime is packaged (bundled Bun script, shipped binary,
 * container entrypoint). The builder receives the parent context so a
 * single daemon adapter can serve many heterogeneous supervisors.
 */
export type CommandBuilder = (
  parentId: AgentId,
  childSpec: ChildSpec,
  manifest: AgentManifest,
) => readonly string[];

export interface CreateDaemonSpawnChildFnOptions {
  readonly supervisor: Supervisor;
  readonly sessionRegistry: BackgroundSessionRegistry;
  readonly agentRegistry: AgentRegistry;
  /** Live bridge — mutated via `mapWorker()` on every spawn. */
  readonly bridge: AgentRegistryBridge;
  readonly commandBuilder: CommandBuilder;
  /**
   * Absolute directory into which each subprocess's stdout/stderr log
   * should be written. When set, logPath = `${logDir}/${workerId}.log`.
   * When unset, `logPath` is empty and the backend routes child output to
   * /dev/null. Operators who want live logs MUST provide this.
   */
  readonly logDir?: string;
  /**
   * Optional cwd override passed through to the supervisor. When unset,
   * the subprocess inherits the daemon process's cwd.
   */
  readonly cwd?: string;
  /**
   * Optional env override passed through to the supervisor.
   * Keys with `null` values instruct the backend to delete that env var
   * from the child — see `WorkerSpawnRequest.env` in `@koi/core/daemon`.
   */
  readonly env?: Readonly<Record<string, string | null>>;
  /**
   * Optional seed for the generated id suffix. Defaults to
   * `crypto.randomUUID`. Tests inject a deterministic generator so
   * assertions can name specific agentIds.
   */
  readonly idSuffix?: () => string;
}

/**
 * Returns a function matching the shape of `SpawnChildFn` in
 * `@koi/engine-reconcile`. Kept structurally typed rather than importing
 * the L1 type so the daemon package stays below the L1 boundary.
 */
export function createDaemonSpawnChildFn(
  opts: CreateDaemonSpawnChildFnOptions,
): (parentId: AgentId, childSpec: ChildSpec, manifest: AgentManifest) => Promise<AgentId> {
  const suffix = opts.idSuffix ?? (() => crypto.randomUUID().slice(0, 8));

  return async (parentId, childSpec, manifest) => {
    const isolation = childSpec.isolation ?? "in-process";
    if (isolation !== "subprocess") {
      throw new Error(
        `daemon SpawnChildFn received childSpec.isolation="${isolation}" for child="${childSpec.name}"; ` +
          `route this child to the in-process adapter instead`,
      );
    }

    const uniq = suffix();
    // AgentIds must be unique across restart attempts: a RegistryEntry with
    // phase=terminated cannot transition back to running, so reusing the id
    // would force a deregister step and race the reconciler's next sweep.
    //
    // Separator is `.` (not `/`) because WorkerId has a stricter character
    // allowlist than AgentId (`[A-Za-z0-9._-]`) and we derive the workerId
    // directly from the agentId to keep operator lookup symmetric
    // (`koi bg ps` → agentId).
    const childAgent = makeAgentId(`${parentId}.${childSpec.name}-${uniq}`);
    const worker = makeWorkerId(`${childAgent}`);

    const logPath = opts.logDir !== undefined ? `${opts.logDir}/${worker}.log` : "";
    const command = opts.commandBuilder(parentId, childSpec, manifest);
    if (command.length === 0) {
      throw new Error(
        `daemon SpawnChildFn: commandBuilder returned an empty command for child="${childSpec.name}"; ` +
          `the subprocess backend requires at least an executable path`,
      );
    }

    const backendKind: WorkerBackendKind = "subprocess";

    // Step 1: pre-register in BackgroundSessionRegistry. pid=0 is a
    // placeholder; `attachRegistry` will patch the real pid when the
    // supervisor's `started` event lands. startedAt is deliberately "now"
    // so operators listing ps while the spawn is in flight see a sensible
    // age instead of epoch-zero.
    const registerResult = await opts.sessionRegistry.register({
      workerId: worker,
      agentId: childAgent,
      pid: 0,
      status: "starting",
      startedAt: Date.now(),
      logPath,
      command,
      backendKind,
    });
    if (!registerResult.ok) {
      throw new Error(
        `daemon SpawnChildFn: sessionRegistry.register failed (${registerResult.error.code}): ${registerResult.error.message}`,
      );
    }

    // Step 2: register in AgentRegistry so ProcessTree (which reads
    // RegistryEntry.parentId) enrolls the child in the parent's subtree
    // on its `registered` notification. Without this, the reconciler
    // can't find the child via `processTree.childrenOf(parent)` and its
    // level-triggered loop never notices the subprocess.
    try {
      await opts.agentRegistry.register({
        agentId: childAgent,
        parentId,
        spawner: parentId,
        status: {
          phase: "created",
          generation: 0,
          conditions: [],
          lastTransitionAt: Date.now(),
        },
        agentType: "worker",
        metadata: {
          name: manifest.name,
          // childSpecName is load-bearing: the reconciler's level-triggered
          // loop matches children to specs via this field (with a
          // positional fallback). Omitting it would cause a sibling
          // childSpec to be "matched" under the wrong name on restart.
          childSpecName: childSpec.name,
        },
        registeredAt: Date.now(),
        priority: 10,
      });
    } catch (e: unknown) {
      // Roll back the sessionRegistry registration to avoid a zombie
      // "starting" record the bridge will never resolve.
      await opts.sessionRegistry.unregister(worker).catch(() => {
        /* best-effort cleanup */
      });
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`daemon SpawnChildFn: agentRegistry.register failed: ${msg}`);
    }

    // Step 3: map the workerId BEFORE supervisor.start so a racing
    // `started` event arriving on the watchAll stream finds the
    // destination agent. Registering the mapping after start could drop
    // the `started` event if the supervisor publishes it synchronously.
    opts.bridge.mapWorker(worker, childAgent);

    // Step 4: start the subprocess. Failure here must roll back both
    // registrations to keep the parent's view consistent — an un-started
    // child in the AgentRegistry would get reconciled as "terminated due
    // to missing" and trigger a restart attempt, masking the real
    // underlying spawn failure.
    const startResult = await opts.supervisor.start({
      workerId: worker,
      agentId: childAgent,
      command,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    if (!startResult.ok) {
      opts.bridge.unmapWorker(worker);
      await opts.sessionRegistry.unregister(worker).catch(() => {});
      const entry = await opts.agentRegistry.lookup(childAgent);
      if (entry !== undefined) {
        // Mark terminated so the reconciler's next sweep sees the failure
        // and applies the childSpec.restart policy (transient/permanent
        // children will be respawned; temporary children will stay dead).
        await opts.agentRegistry.transition(childAgent, "terminated", entry.status.generation, {
          kind: "error",
          cause: startResult.error.message,
        });
      }
      throw new Error(
        `daemon SpawnChildFn: supervisor.start failed (${startResult.error.code}): ${startResult.error.message}`,
      );
    }

    return childAgent;
  };
}
