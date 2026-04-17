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
 * `wake` is set by the task while it is sleeping; stop()/shutdown() invoke
 * it to short-circuit the backoff sleep and advance the task immediately.
 */
interface RestartingEntry {
  cancelled: boolean;
  readonly done: Promise<void>;
  wake: (() => void) | undefined;
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

  /**
   * Deadline-bounded worker teardown. Races `backend.terminate()` against
   * `shutdownDeadlineMs`; on deadline or terminate failure, races
   * `backend.kill()` against another `shutdownDeadlineMs` window. Used by:
   *   - `stop()` for live pool workers
   *   - the late-admission path in `performSpawn()` when shutdown or
   *     explicit cancellation fires during `backend.spawn()`
   *   - the watch-stream fault path where we must ensure the OS-level
   *     worker is actually dead before declaring the entry gone
   *
   * `observeExit` may be undefined when the supervisor has no observed-exit
   * signal (late admission, watch-stream fault). In that case the helper
   * relies purely on the deadline + `isAlive()` check.
   */
  const teardownWorker = async (
    backend: WorkerBackend,
    id: WorkerId,
    reason: string,
    observeExit: Promise<void> | undefined,
  ): Promise<Result<void, KoiError>> => {
    // The exit signal is whichever resolves first: a pre-wired observed-exit
    // promise from the watch loop, OR a poll of backend.isAlive() every 20ms.
    // Polling bounds the "no observer" case — otherwise the deadline would
    // always fire even for a worker that already exited.
    const poll = async (): Promise<"exited"> => {
      while (true) {
        if (!(await backend.isAlive(id))) return "exited";
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const exitedSignal = Promise.race([
      (observeExit ?? new Promise<void>(() => {})).then(() => "exited" as const),
      poll(),
    ]).then(() => ({ kind: "exited" as const }));

    // Fire terminate without awaiting; a hung RPC must not block the deadline.
    void backend.terminate(id, reason).catch(() => undefined);

    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<{ kind: "deadline" }>((resolve) => {
      deadlineHandle = setTimeout(() => resolve({ kind: "deadline" }), config.shutdownDeadlineMs);
    });
    const first = await Promise.race([exitedSignal, deadlinePromise]);
    clearTimeout(deadlineHandle);
    if (first.kind === "exited") return { ok: true, value: undefined };

    // Deadline fired — fall back to kill, also deadline-bounded. A hung
    // kill() is surfaced as INTERNAL failure so callers see partial shutdown.
    void backend.kill(id).catch(() => undefined);
    let killHandle: ReturnType<typeof setTimeout> | undefined;
    const killDeadline = new Promise<{ kind: "deadline" }>((resolve) => {
      killHandle = setTimeout(() => resolve({ kind: "deadline" }), config.shutdownDeadlineMs);
    });
    const killWinner = await Promise.race([exitedSignal, killDeadline]);
    clearTimeout(killHandle);
    if (killWinner.kind === "deadline") {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Worker ${id} did not exit after kill within shutdownDeadlineMs`,
          retryable: false,
        },
      };
    }
    return { ok: true, value: undefined };
  };

  /**
   * Schedule a respawn with cancellable backoff. stop() and shutdown() can
   * flip `cancelled` AND invoke `wake()` to short-circuit the sleep, so they
   * never wait the full policy.backoffBaseMs * 2^attempt window.
   */
  const scheduleRestart = (
    previous: PoolEntry,
    request: WorkerSpawnRequest,
    policy: WorkerRestartPolicy,
    recentTimestamps: readonly number[],
    now: number,
  ): void => {
    let resolveRestartDone: () => void = () => {};
    const restartDonePromise = new Promise<void>((resolve) => {
      resolveRestartDone = resolve;
    });
    const entry: RestartingEntry = {
      cancelled: false,
      done: restartDonePromise,
      wake: undefined,
    };
    restarting.set(request.workerId, entry);

    const restartTask = (async () => {
      try {
        const backoff = Math.min(
          policy.backoffBaseMs * 2 ** previous.restartAttempts,
          policy.backoffCeilingMs,
        );
        if (backoff > 0) {
          // Cancellable sleep. stop()/shutdown() invoke entry.wake to
          // resolve early; otherwise the timer fires normally. Either way
          // we land in the same shutdown/cancel check below.
          await new Promise<void>((resolve) => {
            entry.wake = resolve;
            const handle = setTimeout(() => {
              entry.wake = undefined;
              resolve();
            }, backoff);
            // If a waker is called before timer fires, clear the timer so we
            // don't hold a handle after resolving.
            entry.wake = (): void => {
              clearTimeout(handle);
              entry.wake = undefined;
              resolve();
            };
          });
        }
        if (shuttingDown || entry.cancelled) {
          activeIds.delete(request.workerId);
          return;
        }
        const respawned = await performSpawn(
          request,
          { restart: policy, backend: previous.handle.backendKind },
          true,
        );
        if (respawned.ok) {
          const newEntry = pool.get(request.workerId);
          if (newEntry !== undefined) {
            newEntry.restartAttempts = previous.restartAttempts + 1;
            newEntry.restartTimestamps = [...recentTimestamps, now];
          }
        } else {
          activeIds.delete(request.workerId);
        }
      } finally {
        restarting.delete(request.workerId);
        resolveRestartDone();
      }
    })();
    pendingRestarts.add(restartTask);
    void restartTask.finally(() => pendingRestarts.delete(restartTask));
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
      // Deadline-bounded teardown of the late admission — see teardownWorker.
      // We do NOT have an observed-exit signal here (the watch IIFE never
      // attached), so the helper polls backend.isAlive() after kill().
      await teardownWorker(backend, request.workerId, "cancelled-during-spawn", undefined);
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

          scheduleRestart(current, request, policy, recentTimestamps, now);
          return;
        }
      } catch (e) {
        // Watch stream faulted. The underlying worker may still be alive;
        // losing observability does NOT imply the process died. Run a
        // deadline-bounded teardown. If teardown succeeds, apply normal
        // restart policy. If teardown FAILS, we cannot confirm the old
        // worker is dead — quarantine it (drop pool+activeIds but DO NOT
        // respawn, since that would create a duplicate live worker).
        const current = pool.get(request.workerId);
        const syntheticError: KoiError = {
          code: "INTERNAL",
          message: `Backend watch stream closed: ${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
        };

        if (current === undefined) {
          // Fault before pool admission (shouldn't happen today, but handle).
          publishEvent({
            kind: "crashed",
            workerId: request.workerId,
            at: Date.now(),
            error: syntheticError,
          });
          activeIds.delete(request.workerId);
          return;
        }

        const teardownResult = await teardownWorker(
          current.backend,
          request.workerId,
          "watch-stream-fault",
          undefined,
        );
        current.resolveExited();
        pool.delete(request.workerId);

        if (!teardownResult.ok) {
          // Teardown failed — the old worker may still be alive. Surface
          // the failure via a synthetic crashed event whose error carries
          // BOTH the watch fault and the teardown failure context, then
          // release activeIds so the caller can investigate, but do NOT
          // respawn (that would risk duplicate live workers).
          publishEvent({
            kind: "crashed",
            workerId: request.workerId,
            at: Date.now(),
            error: {
              code: "INTERNAL",
              message: `${syntheticError.message}; teardown failed: ${teardownResult.error.message}`,
              retryable: false,
            },
          });
          activeIds.delete(request.workerId);
          return;
        }

        // Teardown succeeded — the old worker is confirmed dead. Now it's
        // safe to emit the synthetic crashed event and schedule a restart
        // per policy.
        const syntheticCrash: WorkerEvent = {
          kind: "crashed",
          workerId: request.workerId,
          at: Date.now(),
          error: syntheticError,
        };
        publishEvent(syntheticCrash);

        if (shuttingDown) {
          activeIds.delete(request.workerId);
          return;
        }

        const policy = current.policy;
        const shouldRestart = policy.restart !== "temporary";
        const now = syntheticCrash.at;
        const windowStart = now - policy.maxRestartWindowMs;
        const recentTimestamps = current.restartTimestamps.filter((t) => t >= windowStart);
        if (current.stopping || !shouldRestart || recentTimestamps.length >= policy.maxRestarts) {
          activeIds.delete(request.workerId);
          return;
        }

        scheduleRestart(current, request, policy, recentTimestamps, now);
      }
    })();

    return { ok: true, value: spawned.value };
  };

  const start: Supervisor["start"] = (request, overrides) =>
    performSpawn(request, overrides, false);

  const stop: Supervisor["stop"] = async (id, reason) => {
    // Case A: worker's spawn is in flight (activeIds set, not in pool yet).
    // Flip cancelled; the spawn code re-checks after backend.spawn()
    // resolves and terminates the late admission. Race spawnDone against
    // the shutdown deadline so a wedged backend.spawn() cannot hang stop().
    const spawnCancel = pendingSpawnCancellations.get(id);
    if (spawnCancel !== undefined && pool.get(id) === undefined) {
      spawnCancel.cancelled = true;
      let cancelDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const cancelDeadline = new Promise<"deadline">((resolve) => {
        cancelDeadlineHandle = setTimeout(() => resolve("deadline"), config.shutdownDeadlineMs);
      });
      const winner = await Promise.race([
        spawnCancel.done.then(() => "settled" as const),
        cancelDeadline,
      ]);
      clearTimeout(cancelDeadlineHandle);
      if (winner === "deadline") {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `stop(${id}): backend.spawn() did not resolve within shutdownDeadlineMs`,
            retryable: true,
          },
        };
      }
      // Handle the corner case: the spawn resolved BEFORE we flipped
      // cancelled, so the worker entered the pool instead of self-terminating.
      // Fall through to the normal pool-stop path below so the caller still
      // observes a cleanly-stopped worker.
      if (pool.get(id) === undefined) {
        return { ok: true, value: undefined };
      }
    }

    // Case B: worker is sleeping in restart backoff (crash observed, respawn
    // pending). We cancel the restart task, wake it out of its sleep, and
    // wait for it to bail — bounded because wake short-circuits the timer.
    const restartEntry = restarting.get(id);
    if (restartEntry !== undefined && pool.get(id) === undefined) {
      restartEntry.cancelled = true;
      if (restartEntry.wake !== undefined) restartEntry.wake();
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

    // Deadline-bounded terminate/kill. See teardownWorker for semantics.
    return teardownWorker(entry.backend, id, reason, entry.exitedPromise);
  };

  const shutdown: Supervisor["shutdown"] = async (reason) => {
    shuttingDown = true;

    // Mark every in-flight spawn cancelled so their post-spawn re-check
    // takes the shutdown-termination branch even if shuttingDown itself
    // was set too late. This is belt-and-suspenders on top of the
    // shuttingDown flag; it also ensures a stuck spawn that eventually
    // resolves still self-cleans.
    for (const cancel of pendingSpawnCancellations.values()) {
      cancel.cancelled = true;
    }

    // Wake every restart task out of its backoff sleep so pendingRestarts
    // drains promptly instead of waiting the full backoff window. Each
    // woken task then sees shuttingDown=true and bails without respawning.
    for (const entry of restarting.values()) {
      entry.cancelled = true;
      if (entry.wake !== undefined) entry.wake();
    }

    // Drain pending spawns and live pool workers IN PARALLEL, bounded by
    // shutdownDeadlineMs. If a backend.spawn() stalls, we do not want to
    // prevent stop() from running against every already-live worker.
    const drainSpawns = (async () => {
      while (pendingSpawnPromises.size > 0) {
        await Promise.all([...pendingSpawnPromises]);
      }
    })();

    const ids = [...pool.keys()];
    const stopsPromise = Promise.all(ids.map((id) => stop(id, reason)));

    // Bound the whole-shutdown wait by 2× the deadline: one window for
    // terminate and one for kill inside each stop(). Individual stops
    // enforce their own deadlines, so this is just a final guard against
    // pathologically-stuck backends.
    let shutdownDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const shutdownDeadline = new Promise<"timeout">((resolve) => {
      shutdownDeadlineHandle = setTimeout(() => resolve("timeout"), config.shutdownDeadlineMs * 2);
    });

    const winner = await Promise.race([
      Promise.all([drainSpawns, stopsPromise]).then(() => "clean" as const),
      shutdownDeadline,
    ]);
    clearTimeout(shutdownDeadlineHandle);

    if (winner === "timeout") {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Supervisor shutdown exceeded deadline; some workers may still be running",
          retryable: false,
        },
      };
    }

    // Drain any in-flight restart tasks started before shuttingDown was set.
    // They each check shuttingDown after backoff and bail.
    while (pendingRestarts.size > 0) {
      await Promise.all([...pendingRestarts]);
    }

    // Collect stop results we can actually observe (stopsPromise already
    // resolved because winner === "clean").
    const stopResults = await stopsPromise;
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
