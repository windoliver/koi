import type {
  KoiError,
  ProcessDescriptor,
  Result,
  Supervisor,
  SupervisorConfig,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerRestartPolicy,
} from "@koi/core";
import { DEFAULT_WORKER_RESTART_POLICY, validateSupervisorConfig } from "@koi/core";

/**
 * Internal pool entry. `restartAttempts` and `restartTimestamps` are mutated
 * in place by the watch loop (Task 5) — do NOT copy the entry to a new
 * object when updating, which would require banned `as` casts. Mutate the
 * existing map entry's counters directly via the Map reference.
 */
interface PoolEntry {
  readonly handle: WorkerHandle;
  readonly backend: WorkerBackend;
  readonly policy: WorkerRestartPolicy;
  restartAttempts: number;
  restartTimestamps: number[];
}

const BACKEND_PREFERENCE: readonly WorkerBackendKind[] = [
  "subprocess",
  "in-process",
  "tmux",
  "remote",
];

export function createSupervisor(config: SupervisorConfig): Result<Supervisor, KoiError> {
  const validated = validateSupervisorConfig(config);
  if (!validated.ok) return validated;

  const pool = new Map<WorkerId, PoolEntry>();
  const defaultPolicy = config.restart ?? DEFAULT_WORKER_RESTART_POLICY;

  const pickBackend = (kind?: WorkerBackendKind): WorkerBackend | undefined => {
    if (kind !== undefined) return config.backends[kind];
    for (const k of BACKEND_PREFERENCE) {
      const b = config.backends[k];
      if (b !== undefined) return b;
    }
    return undefined;
  };

  const start: Supervisor["start"] = async (request, overrides) => {
    if (pool.size >= config.maxWorkers) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Supervisor at maxWorkers=${config.maxWorkers}`,
          retryable: true,
        },
      };
    }
    const backend = pickBackend(overrides?.backend);
    if (backend === undefined) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "No registered backend can handle this spawn",
          retryable: false,
        },
      };
    }
    const spawned = await backend.spawn(request);
    if (!spawned.ok) return spawned;
    pool.set(request.workerId, {
      handle: spawned.value,
      backend,
      policy: overrides?.restart ?? defaultPolicy,
      restartAttempts: 0,
      restartTimestamps: [],
    });

    // Watch backend events for this worker — drive restart policy.
    // Fire-and-forget: the loop lives as long as the worker does.
    void (async () => {
      try {
        for await (const ev of backend.watch(request.workerId)) {
          if (ev.kind !== "exited" && ev.kind !== "crashed") continue;

          const entry = pool.get(request.workerId);
          if (entry === undefined) return;

          // Decide whether to restart based on policy + exit kind.
          const policy = entry.policy;
          const shouldRestart =
            ev.kind === "crashed" ? policy.restart !== "temporary" : policy.restart === "permanent";

          // Check restart budget (maxRestarts within window).
          const now = ev.at;
          const windowStart = now - policy.maxRestartWindowMs;
          const recentTimestamps = entry.restartTimestamps.filter((t) => t >= windowStart);

          // Remove the dead entry from the pool so maxWorkers frees up.
          pool.delete(request.workerId);

          if (!shouldRestart) return;
          if (recentTimestamps.length >= policy.maxRestarts) return;

          // Backoff before restart.
          const backoff = Math.min(
            policy.backoffBaseMs * 2 ** entry.restartAttempts,
            policy.backoffCeilingMs,
          );
          if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));

          // Respawn via the same backend. `start` will re-add to pool.
          const respawned = await start(request, {
            restart: policy,
            backend: entry.handle.backendKind,
          });

          if (respawned.ok) {
            // Carry restart-accounting forward by mutating the new entry in place.
            const newEntry = pool.get(request.workerId);
            if (newEntry !== undefined) {
              newEntry.restartAttempts = entry.restartAttempts + 1;
              newEntry.restartTimestamps = [...recentTimestamps, now];
            }
          }
          return;
        }
      } catch {
        // Backend watch stream closed unexpectedly — treat as exit with no restart.
      }
    })();

    return { ok: true, value: spawned.value };
  };

  const stop: Supervisor["stop"] = async (_id, _reason) => {
    // Implemented in Task 6
    return { ok: true, value: undefined };
  };

  const shutdown: Supervisor["shutdown"] = async (_reason) => {
    // Implemented in Task 6
    return { ok: true, value: undefined };
  };

  const list: Supervisor["list"] = () => {
    const out: ProcessDescriptor[] = [];
    for (const entry of pool.values()) {
      out.push({
        agentId: entry.handle.agentId,
        state: "running",
        conditions: [],
        generation: 1,
        registeredAt: entry.handle.startedAt,
      });
    }
    return out;
  };

  const emptyEvents: readonly WorkerEvent[] = [];
  const watchAll: Supervisor["watchAll"] = async function* (): AsyncIterable<WorkerEvent> {
    // Implemented in Task 7
    yield* emptyEvents;
  };

  return { ok: true, value: { start, stop, shutdown, list, watchAll } };
}
