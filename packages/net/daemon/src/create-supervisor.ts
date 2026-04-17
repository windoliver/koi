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

/**
 * Bookkeeping for a worker that has crashed and is sleeping in restart backoff.
 * `cancelled` is checked by the restart task after backoff; if true, the
 * task aborts instead of respawning. `done` resolves when the task finishes
 * (either aborted or respawned), so `stop()` can wait for clean teardown.
 */
interface RestartingEntry {
  cancelled: boolean;
  readonly done: Promise<void>;
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
  // Workers currently sleeping between crash and respawn. stop() uses this
  // so it can cancel a restart-looping worker; shutdown() uses this to await
  // each restart task's clean teardown.
  const restarting = new Map<WorkerId, RestartingEntry>();
  // In-flight restart tasks — shutdown() awaits these so pending respawns
  // cannot resurrect workers after shutdown returns.
  const pendingRestarts = new Set<Promise<void>>();
  // In-flight spawn attempts (past capacity check, awaiting backend.spawn).
  // Counted against maxWorkers so concurrent start() calls cannot both pass
  // the capacity check before either lands in the pool.
  let pendingSpawns = 0;
  // In-flight spawn promises so shutdown() can await them and any late
  // admissions observe shuttingDown=true after backend.spawn resolves.
  const pendingSpawnPromises = new Set<Promise<void>>();
  // Per-workerId cancellation state for spawns currently awaiting
  // backend.spawn(). stop(id) during a slow spawn flips `cancelled`; the
  // spawn code re-checks after backend.spawn resolves and terminates the
  // late admission instead of entering it into the pool. `done` resolves
  // when the spawn has fully settled so stop() returns on a quiesced state.
  const pendingSpawnCancellations = new Map<
    WorkerId,
    { cancelled: boolean; readonly done: Promise<void> }
  >();
  let shuttingDown = false;
  const defaultPolicy = config.restart ?? DEFAULT_WORKER_RESTART_POLICY;

  // Fan-in event bus with bounded ring-buffer semantics.
  //   - eventBuffer holds at most EVENT_BUFFER_MAX events; oldest are evicted.
  //   - droppedCount tracks the logical index of eventBuffer[0], so subscriber
  //     cursors (also logical indices) advance correctly even after eviction.
  //   - Subscribers that fall more than EVENT_BUFFER_MAX events behind silently
  //     skip to the current front. Gap reporting is deferred to follow-up work.
  //   - eventWakers stores one resolver per waiting subscriber. Abandoned
  //     iterators remove their waker in watchAll's finally block.
  const EVENT_BUFFER_MAX = 1000;
  const eventBuffer: WorkerEvent[] = [];
  let droppedCount = 0;
  const eventWakers: Array<() => void> = [];

  const publishEvent = (ev: WorkerEvent): void => {
    eventBuffer.push(ev);
    if (eventBuffer.length > EVENT_BUFFER_MAX) {
      eventBuffer.shift();
      droppedCount++;
    }
    // Wake every pending subscriber once. They will re-read the buffer from
    // their cursor position on the next iteration — no value is passed through
    // the promise, to avoid losing events pushed between drain and wakeup.
    const pending = [...eventWakers];
    eventWakers.length = 0;
    for (const wake of pending) wake();
  };

  // Async so we can consult backend.isAvailable() — e.g. a subprocess backend
  // in a non-Bun environment, or a remote backend whose transport isn't up
  // yet. Explicit `overrides.backend` is still honored verbatim (callers who
  // name a backend want that backend, not a fallback).
  const pickBackend = async (kind?: WorkerBackendKind): Promise<WorkerBackend | undefined> => {
    if (kind !== undefined) return config.backends[kind];
    for (const k of BACKEND_PREFERENCE) {
      const b = config.backends[k];
      if (b === undefined) continue;
      if (await b.isAvailable()) return b;
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
    // Include pendingSpawns so concurrent start() calls share the budget and
    // cannot both pass this check for the same slot.
    if (pool.size + pendingSpawns >= config.maxWorkers) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Supervisor at maxWorkers=${config.maxWorkers}`,
          retryable: true,
        },
      };
    }

    // Reserve the id and capacity slot SYNCHRONOUSLY — before any await —
    // so concurrent start() calls observe these reservations in their
    // checks above. pickBackend is async (may call isAvailable()), which
    // would otherwise let multiple callers race past the capacity check.
    activeIds.add(request.workerId);
    pendingSpawns++;

    // Register this spawn as in-flight so shutdown() can await it.
    let resolveSpawnDone: () => void = () => {};
    const spawnDone = new Promise<void>((resolve) => {
      resolveSpawnDone = resolve;
    });
    pendingSpawnPromises.add(spawnDone);

    // Install a cancellation record so stop(id) can abort this spawn before
    // the worker enters the pool. `done` resolves whenever releaseReservations()
    // runs OR when the pool admission path completes — whichever wins.
    // Multiple concurrent spawns for the same id are prevented by activeIds.
    const cancellation = {
      cancelled: false,
      done: spawnDone,
    };
    pendingSpawnCancellations.set(request.workerId, cancellation);

    // Helper: release every reservation made above (id, capacity slot,
    // spawn-tracking promise). Used by every failure path in the remainder
    // of this function.
    const releaseReservations = (): void => {
      pendingSpawns--;
      if (!fromRestart) activeIds.delete(request.workerId);
      pendingSpawnPromises.delete(spawnDone);
      pendingSpawnCancellations.delete(request.workerId);
      resolveSpawnDone();
    };

    const backend = await pickBackend(overrides?.backend);
    if (backend === undefined) {
      releaseReservations();
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "No registered backend can handle this spawn",
          retryable: false,
        },
      };
    }

    let spawned: Result<WorkerHandle, KoiError>;
    try {
      spawned = await backend.spawn(request);
    } catch (e) {
      releaseReservations();
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `backend.spawn threw: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        },
      };
    }
    if (!spawned.ok) {
      releaseReservations();
      return spawned;
    }

    // Re-check shuttingDown AND explicit stop() cancellation AFTER the
    // backend spawn resolves. If either flag is set, the new worker is a
    // late admission that must be torn down immediately and never enter
    // the pool. Awaiting terminate/kill here (instead of fire-and-forget)
    // guarantees shutdown()'s pool-drain step runs on a fully quiesced
    // backend, and that stop() callers see the worker truly gone on return.
    if (shuttingDown || cancellation.cancelled) {
      try {
        await backend.terminate(request.workerId, "cancelled-during-spawn");
      } catch {
        // Swallow: we are already on the cancellation path.
      }
      try {
        await backend.kill(request.workerId);
      } catch {
        // Swallow.
      }
      const reason = shuttingDown
        ? "Supervisor began shutting down during spawn; worker terminated"
        : "stop() cancelled the spawn before the worker could enter the pool";
      releaseReservations();
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: reason,
          retryable: false,
        },
      };
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
    // Worker is admitted to the pool. Release the spawn-tracking promise
    // and capacity reservation — shutdown's normal pool-draining logic now
    // owns this worker's lifecycle. Do NOT release activeIds here; that
    // remains reserved until the worker's crash/exit watch loop decides.
    pendingSpawns--;
    pendingSpawnPromises.delete(spawnDone);
    pendingSpawnCancellations.delete(request.workerId);
    resolveSpawnDone();

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

          // Register restart task so shutdown() and stop() can observe it.
          // The shared `restartingEntry` is created BEFORE the async IIFE so
          // stop() can find and cancel it immediately — there is no race
          // between scheduling and a caller reaching for the entry.
          let resolveRestartDone: () => void = () => {};
          const restartDonePromise = new Promise<void>((resolve) => {
            resolveRestartDone = resolve;
          });
          const restartingEntry: RestartingEntry = {
            cancelled: false,
            done: restartDonePromise,
          };
          restarting.set(request.workerId, restartingEntry);

          const restartTask = (async () => {
            try {
              const backoff = Math.min(
                policy.backoffBaseMs * 2 ** current.restartAttempts,
                policy.backoffCeilingMs,
              );
              if (backoff > 0) {
                await new Promise((r) => setTimeout(r, backoff));
              }
              // Re-check shutdown AND cancellation AFTER backoff. stop()
              // can flip `cancelled` during the sleep to abort the respawn,
              // and shutdown() sets `shuttingDown` for the same effect.
              if (shuttingDown || restartingEntry.cancelled) {
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
            } finally {
              restarting.delete(request.workerId);
              resolveRestartDone();
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
    // Case A: worker's spawn is in flight (activeIds set, not in pool yet).
    // Flip cancelled; the spawn code re-checks after backend.spawn()
    // resolves and terminates the late admission. Await its spawnDone so
    // stop() returns only once the worker is fully gone.
    const spawnCancel = pendingSpawnCancellations.get(id);
    if (spawnCancel !== undefined && pool.get(id) === undefined) {
      spawnCancel.cancelled = true;
      await spawnCancel.done;
      // Handle the corner case: the spawn resolved BEFORE we flipped
      // cancelled, so the worker entered the pool instead of self-terminating.
      // Fall through to the normal pool-stop path below so the caller still
      // observes a cleanly-stopped worker.
      if (pool.get(id) === undefined) {
        return { ok: true, value: undefined };
      }
    }

    // Case B: worker is sleeping in restart backoff (crash observed, respawn
    // pending). We cancel the restart task and wait for it to bail.
    const restartEntry = restarting.get(id);
    if (restartEntry !== undefined && pool.get(id) === undefined) {
      restartEntry.cancelled = true;
      await restartEntry.done;
      return { ok: true, value: undefined };
    }

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

    // Drain pending spawns FIRST so any late admission (spawn-during-shutdown)
    // can observe shuttingDown=true, self-terminate, and not leave a process
    // running after we return.
    while (pendingSpawnPromises.size > 0) {
      await Promise.all([...pendingSpawnPromises]);
    }

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
    // cursor is a LOGICAL index — not a buffer offset. droppedCount tracks how
    // many events were evicted from the front of eventBuffer, so the physical
    // index for cursor is (cursor - droppedCount). A subscriber that falls
    // more than EVENT_BUFFER_MAX events behind has its cursor silently
    // fast-forwarded to the oldest retained event.
    let cursor = 0;
    // Keep the current waker resolver so the finally block (triggered on
    // iterator.return() or break/throw) can resolve the parked promise AND
    // evict the waker from the registry. Without unblocking the promise,
    // iterator.return() would hang forever because async-generator cancel
    // waits for the current await to settle.
    let currentWaker: (() => void) | undefined;
    try {
      while (true) {
        // Fast-forward past evicted events if we fell behind.
        if (cursor < droppedCount) cursor = droppedCount;
        // Drain all currently-buffered events for this subscriber's cursor.
        while (cursor - droppedCount < eventBuffer.length) {
          const idx = cursor - droppedCount;
          const ev = eventBuffer[idx];
          cursor++;
          if (ev !== undefined) yield ev;
        }
        // Wait for next publish.
        await new Promise<void>((resolve) => {
          currentWaker = resolve;
          eventWakers.push(resolve);
        });
        currentWaker = undefined;
      }
    } finally {
      // Iterator was returned early (break, throw, abandoned). Evict our
      // waker from the registry AND resolve it so the supervisor doesn't
      // leak a reference for the rest of its lifetime.
      if (currentWaker !== undefined) {
        const idx = eventWakers.indexOf(currentWaker);
        if (idx !== -1) eventWakers.splice(idx, 1);
        currentWaker();
      }
    }
  };

  return { ok: true, value: { start, stop, shutdown, list, watchAll } };
}
