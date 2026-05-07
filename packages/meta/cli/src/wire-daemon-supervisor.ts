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

import type { AgentManifest, KoiError, Result } from "@koi/core";
import type {
  Supervisor,
  SupervisorConfig,
  WorkerBackendKind,
  WorkerRestartPolicy,
  WorkerSpawnRequest,
} from "@koi/core/daemon";
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

const BACKEND_PREFERENCE: readonly WorkerBackendKind[] = [
  "subprocess",
  "in-process",
  "tmux",
  "remote",
];
const REGISTRATION_PROBE_TIMEOUT_MS = 1_000;

function failedStartMayHaveAdmittedWorker(error: KoiError): boolean {
  if (error.code === "TIMEOUT") return true;
  return (
    error.code === "INTERNAL" &&
    /did not exit after kill|may still be alive|quarantined/i.test(error.message)
  );
}

function heartbeatRequested(request: WorkerSpawnRequest): boolean {
  return request.backendHints?.heartbeat === true;
}

function compatibleRegistrationBackends(
  backends: SupervisorConfig["backends"],
  requireHeartbeat: boolean,
): readonly WorkerBackendKind[] {
  return BACKEND_PREFERENCE.filter((kind) => {
    const backend = backends[kind];
    if (backend === undefined) return false;
    if (requireHeartbeat && backend.supportsHeartbeat !== true) return false;
    return true;
  });
}

async function probeRegistrationBackend(
  backend: NonNullable<SupervisorConfig["backends"][WorkerBackendKind]>,
): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), REGISTRATION_PROBE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => backend.isAvailable())
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
      timeout.then(() => "timeout" as const),
    ]);
    if (result === "timeout") return false;
    if (!result.ok) return false;
    return result.value;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveRegistrationBackendKind(
  backends: SupervisorConfig["backends"],
  request: WorkerSpawnRequest,
  overrides?: {
    readonly restart?: WorkerRestartPolicy;
    readonly backend?: WorkerBackendKind;
  },
): Promise<WorkerBackendKind | undefined> {
  if (overrides?.backend !== undefined) return overrides.backend;

  const requireHeartbeat = heartbeatRequested(request);
  const compatibleKinds = compatibleRegistrationBackends(backends, requireHeartbeat);
  if (compatibleKinds.length <= 1) return compatibleKinds[0];

  for (const kind of compatibleKinds) {
    const backend = backends[kind];
    if (backend === undefined) continue;
    if (await probeRegistrationBackend(backend)) return kind;
  }

  return compatibleKinds[0];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function wireDaemonSupervisor(
  opts: WireDaemonSupervisorOptions,
): Promise<WireDaemonSupervisorHandle> {
  const registry = createFileSessionRegistry({ dir: opts.stateDir });
  const now = opts.clock ?? Date.now;

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

  const unregisterAfterConfirmedStop = async (
    request: WorkerSpawnRequest,
    reason: string,
  ): Promise<Result<void, KoiError>> => {
    const stopResult = await realSupervisor.stop(request.workerId, reason);
    if (!stopResult.ok) return stopResult;
    return registry.unregister(request.workerId);
  };

  // let: bridge and proxy reference each other; assign once during wiring.
  let bridge: DaemonBridge;

  const proxiedSupervisor: Supervisor = {
    ...realSupervisor,
    start: async (request, overrides) => {
      const wId = String(request.workerId);
      bridge.markLocallySpawned(wId);
      let backendKind: WorkerBackendKind | undefined;
      try {
        backendKind = await resolveRegistrationBackendKind(opts.backends, request, overrides);
      } catch (error: unknown) {
        bridge.unmarkLocallySpawned(wId);
        throw error;
      }
      const logPath = opts.logDir !== undefined ? `${opts.logDir}/${wId}.log` : "";
      if (backendKind !== undefined) {
        const registerResult = await registry.register({
          workerId: request.workerId,
          agentId: request.agentId,
          pid: 0,
          status: "starting",
          startedAt: now(),
          logPath,
          command: request.command,
          backendKind,
        });
        if (!registerResult.ok) {
          bridge.unmarkLocallySpawned(wId);
          return registerResult;
        }
      }
      try {
        const result = await realSupervisor.start(request, overrides);
        // Failed admission (capacity, duplicate id, backend error) returns
        // ok:false without producing a terminal lifecycle event, so the
        // bridge's event-driven cleanup never runs. Remove the marker now
        // to avoid authorizing a kill against a future foreign worker that
        // reuses this id.
        if (!result.ok) {
          if (backendKind !== undefined) {
            if (failedStartMayHaveAdmittedWorker(result.error)) {
              await unregisterAfterConfirmedStop(
                request,
                "wire-daemon-supervisor start failed before worker admission was known-safe",
              ).catch(() => undefined);
            } else {
              await registry.unregister(request.workerId).catch(() => undefined);
            }
          }
          bridge.unmarkLocallySpawned(wId);
        }
        if (result.ok && backendKind !== undefined) {
          if (result.value.backendKind !== backendKind) {
            const cleanupResult = await unregisterAfterConfirmedStop(
              request,
              "wire-daemon-supervisor backend mismatch during registration",
            );
            bridge.unmarkLocallySpawned(wId);
            if (!cleanupResult.ok) {
              return {
                ok: false,
                error: cleanupResult.error,
              };
            }
            return {
              ok: false,
              error: {
                code: "INTERNAL",
                message:
                  `wireDaemonSupervisor registered backend "${backendKind}" but ` +
                  `spawned backend "${result.value.backendKind}"`,
                retryable: true,
              },
            };
          }
          const updateResult = await registry.update(request.workerId, {
            startedAt: result.value.startedAt,
            ...(result.value.tmuxSessionName !== undefined && {
              tmuxSessionName: result.value.tmuxSessionName,
            }),
            ...(result.value.tmuxWindowTarget !== undefined && {
              tmuxWindowTarget: result.value.tmuxWindowTarget,
            }),
            ...(result.value.tmuxPaneId !== undefined && {
              tmuxPaneId: result.value.tmuxPaneId,
            }),
          });
          if (!updateResult.ok) {
            const cleanupResult = await unregisterAfterConfirmedStop(
              request,
              "wire-daemon-supervisor failed to persist session metadata",
            );
            bridge.unmarkLocallySpawned(wId);
            if (!cleanupResult.ok) {
              return {
                ok: false,
                error: cleanupResult.error,
              };
            }
            return {
              ok: false,
              error: updateResult.error,
            };
          }
        }
        return result;
      } catch (e: unknown) {
        if (backendKind !== undefined) {
          await unregisterAfterConfirmedStop(
            request,
            "wire-daemon-supervisor start threw before worker admission was known-safe",
          ).catch(() => undefined);
        }
        bridge.unmarkLocallySpawned(wId);
        throw e;
      }
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
    //    and emit `exited` events through `watchAll()`. shutdown() can
    //    legitimately fail (deadline exceeded, backend teardown error).
    //    Whether it succeeds or fails, we still tear down the bridge and
    //    registry attachment so background loops do not outlive the
    //    renderer teardown — leaving them running would prevent a clean
    //    process exit and let stale state continue to mutate.
    const shutdownResult = await realSupervisor.shutdown("wire-daemon-supervisor dispose");
    // 2. Close the bridge so terminal events drain into the store BEFORE
    //    the bridge stops consuming. 3. Drop the attachRegistry consumer.
    //    Done unconditionally so loops never outlive renderer teardown.
    await bridge.close();
    await attachHandle.close();
    if (!shutdownResult.ok) {
      opts.pushToast({
        kind: "warn",
        message: `⚠ supervisor shutdown failed: ${shutdownResult.error.message} — workers may still be running`,
      });
      throw new Error(
        `wireDaemonSupervisor dispose: supervisor.shutdown failed: ${shutdownResult.error.message}`,
        { cause: shutdownResult.error },
      );
    }
  };

  return { supervisor: proxiedSupervisor, registry, bridge, dispose };
}
