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
  WorkerSpawnRequest,
} from "@koi/core";
import { DEFAULT_WORKER_RESTART_POLICY, validateSupervisorConfig } from "@koi/core";

/**
 * Internal pool entry. Mutable fields:
 *   - restartAttempts, restartTimestamps — updated in place by the watch loop
 *   - stopping — set by stop() to suppress restart on the next terminal event
 */
interface PoolEntry {
  readonly handle: WorkerHandle;
  readonly backend: WorkerBackend;
  readonly policy: WorkerRestartPolicy;
  readonly exitedPromise: Promise<void>;
  readonly resolveExited: () => void;
  restartAttempts: number;
  restartTimestamps: number[];
  stopping: boolean;
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
  // Tracks workerIds that are either in pool OR in a restart backoff window.
  // Used to reject duplicate start() calls; persists through the respawn cycle
  // so external callers cannot race a mid-restart worker.
  const activeIds = new Set<WorkerId>();
  // In-flight restart tasks — shutdown() awaits these so pending respawns
  // cannot resurrect workers after shutdown returns.
  const pendingRestarts = new Set<Promise<void>>();
  let shuttingDown = false;
  const defaultPolicy = config.restart ?? DEFAULT_WORKER_RESTART_POLICY;

  // Fan-in event bus — collects events from all worker watch loops.
  // TODO: eventBuffer is unbounded — it grows for the lifetime of the supervisor.
  // For long-running daemons with restart-heavy workers this is a memory leak.
  // Follow-up work: bounded ring-buffer with configurable retention window and
  // a subscriber-abandonment cleanup path that removes stale wakers on iterator
  // return/throw. Acceptable for initial implementation.
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

  // Internal spawn implementation. `fromRestart` distinguishes the recursive
  // respawn path (which has already claimed activeIds earlier) from external
  // callers (which must go through the duplicate-id guard).
  const performSpawn = async (
    request: WorkerSpawnRequest,
    overrides:
      | { readonly restart?: WorkerRestartPolicy; readonly backend?: WorkerBackendKind }
      | undefined,
    fromRestart: boolean,
  ): Promise<Result<WorkerHandle, KoiError>> => {
    if (shuttingDown) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Supervisor is shutting down; not accepting new workers",
          retryable: false,
        },
      };
    }
    if (!fromRestart && activeIds.has(request.workerId)) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Worker ${request.workerId} is already active (live or mid-restart)`,
          retryable: false,
        },
      };
    }
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

    // Reserve the id synchronously so a concurrent start() cannot race past
    // the duplicate-check while backend.spawn() is awaiting.
    activeIds.add(request.workerId);

    const spawned = await backend.spawn(request);
    if (!spawned.ok) {
      if (!fromRestart) activeIds.delete(request.workerId);
      return spawned;
    }

    let resolveExited: () => void = () => {};
    const exitedPromise = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const entry: PoolEntry = {
      handle: spawned.value,
      backend,
      policy: overrides?.restart ?? defaultPolicy,
      exitedPromise,
      resolveExited,
      restartAttempts: 0,
      restartTimestamps: [],
      stopping: false,
    };
    pool.set(request.workerId, entry);

    // Watch backend events for this worker — drive restart policy + exit
    // promise resolution. Fire-and-forget: lives as long as the worker.
    void (async () => {
      try {
        for await (const ev of backend.watch(request.workerId)) {
          publishEvent(ev);
          if (ev.kind !== "exited" && ev.kind !== "crashed") continue;

          const current = pool.get(request.workerId);
          if (current === undefined) return;

          // Resolve the exit promise FIRST so any awaiting stop() can unblock.
          current.resolveExited();
          pool.delete(request.workerId);

          // Decide whether to restart.
          const policy = current.policy;
          const shouldRestart =
            ev.kind === "crashed" ? policy.restart !== "temporary" : policy.restart === "permanent";

          const now = ev.at;
          const windowStart = now - policy.maxRestartWindowMs;
          const recentTimestamps = current.restartTimestamps.filter((t) => t >= windowStart);

          if (current.stopping || shuttingDown) {
            // Explicit teardown OR supervisor shutting down — never restart.
            activeIds.delete(request.workerId);
            return;
          }
          if (!shouldRestart) {
            activeIds.delete(request.workerId);
            return;
          }
          if (recentTimestamps.length >= policy.maxRestarts) {
            activeIds.delete(request.workerId);
            return;
          }

          // Register restart task so shutdown can await it.
          const restartTask = (async () => {
            const backoff = Math.min(
              policy.backoffBaseMs * 2 ** current.restartAttempts,
              policy.backoffCeilingMs,
            );
            if (backoff > 0) {
              await new Promise((r) => setTimeout(r, backoff));
            }
            // Re-check shutdown AFTER backoff — this is the critical race the
            // original code missed: shutdown() could return between the backoff
            // start and the respawn, then respawn would resurrect the worker.
            if (shuttingDown) {
              activeIds.delete(request.workerId);
              return;
            }
            const respawned = await performSpawn(
              request,
              { restart: policy, backend: current.handle.backendKind },
              true,
            );
            if (respawned.ok) {
              const newEntry = pool.get(request.workerId);
              if (newEntry !== undefined) {
                newEntry.restartAttempts = current.restartAttempts + 1;
                newEntry.restartTimestamps = [...recentTimestamps, now];
              }
            } else {
              // Respawn failed — release activeIds so external callers can retry.
              activeIds.delete(request.workerId);
            }
          })();
          pendingRestarts.add(restartTask);
          void restartTask.finally(() => pendingRestarts.delete(restartTask));
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
        // Resolve the exit promise and clean up so stop() doesn't hang and
        // activeIds doesn't leak.
        const current = pool.get(request.workerId);
        if (current !== undefined) {
          current.resolveExited();
          pool.delete(request.workerId);
        }
        activeIds.delete(request.workerId);
      }
    })();

    return { ok: true, value: spawned.value };
  };

  const start: Supervisor["start"] = (request, overrides) =>
    performSpawn(request, overrides, false);

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

    // Signal "don't restart on next terminal event" — the watch loop consults
    // this flag when it observes exit/crash.
    entry.stopping = true;

    // Request graceful terminate. Failures are surfaced in the final return,
    // but we still wait for observed exit — terminate may have partially
    // succeeded and the worker may still exit cleanly.
    const terminateResult = await entry.backend.terminate(id, reason);

    // Race observed exit against deadline. The deadline is enforced on the
    // actual process death, not on the terminate RPC, because many backends
    // (including subprocess) return from terminate() merely after sending a
    // signal — the process may outlive the RPC.
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineHandle = setTimeout(() => resolve("deadline"), config.shutdownDeadlineMs);
    });
    const winner = await Promise.race([
      entry.exitedPromise.then(() => "exited" as const),
      deadlinePromise,
    ]);
    clearTimeout(deadlineHandle);

    if (winner === "deadline") {
      // Force-kill and give a secondary deadline window to observe exit.
      const killResult = await entry.backend.kill(id);
      let killHandle: ReturnType<typeof setTimeout> | undefined;
      const killDeadline = new Promise<"deadline">((resolve) => {
        killHandle = setTimeout(() => resolve("deadline"), config.shutdownDeadlineMs);
      });
      const killWinner = await Promise.race([
        entry.exitedPromise.then(() => "exited" as const),
        killDeadline,
      ]);
      clearTimeout(killHandle);
      if (!killResult.ok) return killResult;
      if (killWinner === "deadline") {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Worker ${id} did not exit after kill within shutdownDeadlineMs`,
            retryable: false,
          },
        };
      }
    }

    // If terminate reported failure AND we observed clean exit, the worker is
    // gone regardless — ignore the terminate error. If terminate failed AND
    // kill was needed AND succeeded, the killResult return above took over.
    // The remaining case: terminate failed but we observed exit — the worker
    // is dead, so return ok.
    if (!terminateResult.ok && winner === "exited") {
      // Worker exited cleanly despite terminate() error — accept success.
      return { ok: true, value: undefined };
    }
    if (!terminateResult.ok) return terminateResult;

    return { ok: true, value: undefined };
  };

  const shutdown: Supervisor["shutdown"] = async (reason) => {
    shuttingDown = true;
    const ids = [...pool.keys()];
    const stopResults = await Promise.all(ids.map((id) => stop(id, reason)));
    // Drain any in-flight restart tasks started before shuttingDown was set.
    // They will each check shuttingDown after their backoff and bail without
    // respawning — so awaiting them guarantees no worker resurrects after
    // shutdown returns.
    while (pendingRestarts.size > 0) {
      await Promise.all([...pendingRestarts]);
    }
    // Propagate the first stop failure so callers can observe partial shutdown.
    for (const r of stopResults) {
      if (!r.ok) return r;
    }
    return { ok: true, value: undefined };
  };

  const list: Supervisor["list"] = () => {
    const out: ProcessDescriptor[] = [];
    for (const entry of pool.values()) {
      out.push({
        agentId: entry.handle.agentId,
        state: entry.stopping ? "terminated" : "running",
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
