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

  const start: Supervisor["start"] = async (request, overrides?) => {
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

  const watchAll: Supervisor["watchAll"] = () => {
    // Implemented in Task 7
    return (async function* (): AsyncGenerator<WorkerEvent> {
      yield* [] as WorkerEvent[];
    })();
  };

  return { ok: true, value: { start, stop, shutdown, list, watchAll } };
}
