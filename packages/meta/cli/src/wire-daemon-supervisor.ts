/**
 * wire-daemon-supervisor — composes createSupervisor + createFileSessionRegistry
 * + attachRegistry + createDaemonBridge for the "live daemon" mode of the TUI.
 *
 * Dispose ordering (CRITICAL — spec acceptance):
 *   1. realSupervisor.shutdown() — stops all workers; emits terminal events
 *   2. bridge.close()           — drains terminal events into the store
 *   3. attachHandle.close()     — stops writing to the registry
 *
 * Proxy: proxiedSupervisor wraps realSupervisor.start so that
 * bridge.markLocallySpawned is called before the underlying start delegates.
 * This ensures the TUI freshness classification treats CLI-spawned workers
 * as "local" from the moment the start call is made.
 */

import type { AgentManifest } from "@koi/core";
import type { Supervisor, SupervisorConfig, WorkerRestartPolicy } from "@koi/core/daemon";
import type { FileSessionRegistry } from "@koi/daemon";
import { attachRegistry, createFileSessionRegistry, createSupervisor } from "@koi/daemon";
import type { TuiAction } from "@koi/tui";
import type { DaemonBridge, DaemonBridgeToast } from "./daemon-bridge.js";
import { createDaemonBridge } from "./daemon-bridge.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type Dispatch = (action: TuiAction) => void;

export interface WireDaemonSupervisorOptions {
  /** Directory to use for FileSessionRegistry. Created if missing. */
  readonly stateDir: string;
  /** Loaded manifest (must declare supervision: with subprocess child). */
  readonly manifest: AgentManifest;
  /** Caller-provided dispatch into the TUI store. */
  readonly dispatch: Dispatch;
  /** Caller-provided toast callback. */
  readonly pushToast: (toast: DaemonBridgeToast) => void;
  /** Optional: subprocess log directory. When unset, logPath="" (logging disabled). */
  readonly logDir?: string | undefined;
  /** Backends keyed by WorkerBackendKind (subprocess required). */
  readonly backends: SupervisorConfig["backends"];
  /** Optional override for max workers. Default 16. */
  readonly maxWorkers?: number | undefined;
  /** Optional clock for testability. */
  readonly clock?: (() => number) | undefined;
}

export interface WireDaemonSupervisorHandle {
  /** Proxied supervisor (calls bridge.markLocallySpawned before delegating start). */
  readonly supervisor: Supervisor;
  readonly registry: FileSessionRegistry;
  readonly bridge: DaemonBridge;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Restart policy constants
// ---------------------------------------------------------------------------

/**
 * Daemon-spawned workers must NOT auto-restart at the supervisor layer.
 * The reconciler is the sole auto-restart authority. Using restart: "temporary"
 * with maxRestarts: 0 ensures any crash surfaces to the reconciler without
 * the supervisor silently respawning the process.
 */
const DAEMON_WORKER_RESTART_POLICY: WorkerRestartPolicy = {
  restart: "temporary",
  maxRestarts: 0,
  maxRestartWindowMs: 60_000,
  backoffBaseMs: 1000,
  backoffCeilingMs: 30_000,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function wireDaemonSupervisor(
  opts: WireDaemonSupervisorOptions,
): Promise<WireDaemonSupervisorHandle> {
  const registry = createFileSessionRegistry({ dir: opts.stateDir });

  const config: SupervisorConfig = {
    maxWorkers: opts.maxWorkers ?? 16,
    shutdownDeadlineMs: 10_000,
    backends: opts.backends,
    restart: DAEMON_WORKER_RESTART_POLICY,
  };

  const supervisorResult = createSupervisor(config);
  if (!supervisorResult.ok) {
    throw new Error(`createSupervisor failed: ${supervisorResult.error.message}`, {
      cause: supervisorResult.error,
    });
  }
  const realSupervisor = supervisorResult.value;

  const attachHandle = attachRegistry({ supervisor: realSupervisor, registry });

  // let: bridge and proxy reference each other; assign once during wiring.
  let bridge: DaemonBridge;

  const proxiedSupervisor: Supervisor = {
    ...realSupervisor,
    start: async (request, overrides) => {
      bridge.markLocallySpawned(String(request.workerId));
      return realSupervisor.start(request, overrides);
    },
  };

  bridge = createDaemonBridge({
    mode: { kind: "live", registry, supervisor: proxiedSupervisor },
    dispatch: opts.dispatch,
    pushToast: opts.pushToast,
    ...(opts.clock !== undefined && { clock: opts.clock }),
  });

  const dispose = async (): Promise<void> => {
    // 1. Stop the supervisor first so all in-flight workers terminate
    //    and emit `exited` events through `watchAll()`.
    await realSupervisor.shutdown("wire-daemon-supervisor dispose");
    // 2. Then close the bridge so terminal events drain into the store
    //    BEFORE the bridge stops consuming.
    await bridge.close();
    // 3. Drop the attachRegistry consumer so it stops writing.
    await attachHandle.close();
  };

  return { supervisor: proxiedSupervisor, registry, bridge, dispose };
}
