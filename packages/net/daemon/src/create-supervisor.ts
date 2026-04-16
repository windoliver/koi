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

  // Fan-in event bus — collects events from all worker watch loops.
  const eventBuffer: WorkerEvent[] = [];
  const eventWakers: Array<() => void> = [];

  const publishEvent = (ev: WorkerEvent): void => {
    eventBuffer.push(ev);
    // Wake every pending subscriber once. They will re-read the buffer from
    // their cursor position on the next iteration — no value is passed through
    // the promise, to avoid losing events pushed between drain and wakeup.
    const pending = [...eventWakers];
    eventWakers.length = 0;
    for (const wake of pending) wake();
  };

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
          publishEvent(ev);
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
      } catch (e) {
        // Surface unexpected backend watch-stream closure as a synthetic crashed event.
        publishEvent({
          kind: "crashed",
          workerId: request.workerId,
          at: Date.now(),
          error: {
            code: "INTERNAL",
            message: `Backend watch stream closed: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
          },
        });
      }
    })();

    return { ok: true, value: spawned.value };
  };

  const stop: Supervisor["stop"] = async (id, reason) => {
    const entry = pool.get(id);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Worker ${id} not tracked`,
          retryable: false,
        },
      };
    }
    // Remove from pool before terminating so the crash-watch IIFE's subsequent
    // `pool.get` returns undefined and no restart is attempted.
    pool.delete(id);

    // Race graceful terminate against the deadline. If terminate takes longer
    // than shutdownDeadlineMs, force-kill.
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const terminatePromise = entry.backend.terminate(id, reason);
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineHandle = setTimeout(() => resolve("deadline"), config.shutdownDeadlineMs);
    });
    const winner = await Promise.race([
      terminatePromise.then(() => "terminated" as const),
      deadlinePromise,
    ]);
    clearTimeout(deadlineHandle);
    if (winner === "deadline") {
      await entry.backend.kill(id);
    }
    return { ok: true, value: undefined };
  };

  const shutdown: Supervisor["shutdown"] = async (reason) => {
    const ids = [...pool.keys()];
    await Promise.all(ids.map((id) => stop(id, reason)));
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

  const watchAll: Supervisor["watchAll"] = async function* (): AsyncIterable<WorkerEvent> {
    // Use a cursor into eventBuffer so late-arriving events (added between yields)
    // are never missed: check for buffered items before each waker await.
    let cursor = 0;
    while (true) {
      // Drain all events available since last yield.
      while (cursor < eventBuffer.length) {
        const ev = eventBuffer[cursor];
        cursor++;
        if (ev !== undefined) yield ev;
      }
      // Wait for next event. The wakeup is just a signal — we'll re-check the
      // buffer above on the next iteration, which handles any burst of events
      // pushed before we woke up.
      await new Promise<void>((resolve) => {
        eventWakers.push(resolve);
      });
    }
  };

  return { ok: true, value: { start, stop, shutdown, list, watchAll } };
}
