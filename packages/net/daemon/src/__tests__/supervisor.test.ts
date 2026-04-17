import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerBackend, WorkerEvent, WorkerSpawnRequest } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createSupervisor } from "../create-supervisor.js";
import { createFakeBackend } from "./fake-backend.js";

const makeRequest = (id: string): WorkerSpawnRequest => ({
  workerId: workerId(id),
  agentId: agentId(`agent-${id}`),
  command: ["echo", "hello"],
});

const makeConfig = (maxWorkers: number): SupervisorConfig => {
  const { backend } = createFakeBackend();
  return {
    maxWorkers,
    shutdownDeadlineMs: 1000,
    backends: { "in-process": backend },
  };
};

describe("createSupervisor.start", () => {
  it("spawns a worker via the registered backend", async () => {
    const supervisorResult = createSupervisor(makeConfig(4));
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const started = await supervisorResult.value.start(makeRequest("w1"));
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.value.workerId).toBe(workerId("w1"));
  });

  it("returns RESOURCE_EXHAUSTED when maxWorkers reached", async () => {
    const supervisorResult = createSupervisor(makeConfig(1));
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const first = await supervisorResult.value.start(makeRequest("w1"));
    expect(first.ok).toBe(true);
    const second = await supervisorResult.value.start(makeRequest("w2"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("RESOURCE_EXHAUSTED");
  });

  it("prefers subprocess backend when multiple are registered", async () => {
    const { backend: inProcess } = createFakeBackend("in-process");
    const { backend: subprocess } = createFakeBackend("subprocess");
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess, "in-process": inProcess },
    });
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const started = await supervisorResult.value.start(makeRequest("w1"));
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.value.backendKind).toBe("subprocess");
  });
});

describe("supervisor stop/shutdown", () => {
  it("gracefully stops a worker within deadline", async () => {
    const { backend, isAlive } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("w1"));
    const stopped = await supervisorResult.value.stop(workerId("w1"), "test");
    expect(stopped.ok).toBe(true);
    expect(isAlive(workerId("w1"))).toBe(false);
  });

  it("shutdown stops every worker in parallel", async () => {
    const { backend, liveWorkerCount } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("w1"));
    await supervisorResult.value.start(makeRequest("w2"));
    await supervisorResult.value.start(makeRequest("w3"));
    expect(liveWorkerCount()).toBe(3);
    await supervisorResult.value.shutdown("SIGTERM");
    // Small yield to let the crash-watch IIFE observe exit events
    await new Promise((r) => setTimeout(r, 20));
    expect(liveWorkerCount()).toBe(0);
  });

  it("returns NOT_FOUND when stopping an unknown worker", async () => {
    const { backend } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    const result = await supervisorResult.value.stop(workerId("ghost"), "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("supervisor watchAll", () => {
  it("yields events from all workers", async () => {
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      // Disable restart so we can cleanly observe crash events without respawn noise.
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1,
        backoffCeilingMs: 10,
      },
    });
    if (!supervisorResult.ok) return;

    await supervisorResult.value.start(makeRequest("w1"));
    await supervisorResult.value.start(makeRequest("w2"));

    const collected: string[] = [];
    const iter = supervisorResult.value
      .watchAll()
      [Symbol.asyncIterator]() as AsyncIterator<WorkerEvent>;

    // Trigger two crashes after subscribing so events land in the queue.
    crash(workerId("w1"));
    crash(workerId("w2"));

    // Drain up to 4 events (2 started + 2 crashed) with short timeouts.
    for (let i = 0; i < 4; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<WorkerEvent>>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined as unknown as WorkerEvent }),
            100,
          ),
        ),
      ]);
      if (!r.done && r.value !== undefined) {
        const ev = r.value;
        collected.push(`${ev.kind}:${ev.workerId}`);
      } else {
        break;
      }
    }

    // We should see crashed events for both workers, in some order.
    const crashedEvents = collected.filter((e) => e.startsWith("crashed:"));
    const crashedWorkerIds = crashedEvents.map((e) => e.split(":")[1]).sort();
    expect(crashedWorkerIds).toEqual(["w1", "w2"]);
  });

  it("delivers events published in the same microtask burst", async () => {
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1,
        backoffCeilingMs: 10,
      },
    });
    if (!supervisorResult.ok) return;

    await supervisorResult.value.start(makeRequest("ba"));
    await supervisorResult.value.start(makeRequest("bb"));
    await supervisorResult.value.start(makeRequest("bc"));

    // Start subscribing BEFORE publishing the burst.
    const iter = supervisorResult.value.watchAll()[Symbol.asyncIterator]() as AsyncIterator<
      import("@koi/core").WorkerEvent
    >;

    // Drain buffered `started` events first — synchronously advance the cursor.
    // Start 3 workers → 3 started events buffered.
    const buffered = [];
    for (let i = 0; i < 3; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<import("@koi/core").WorkerEvent>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined as never }), 50),
        ),
      ]);
      if (!r.done) buffered.push(r.value);
    }
    expect(buffered.length).toBe(3);

    // Now fire three crashes in the same microtask turn — this is the race case.
    crash(workerId("ba"));
    crash(workerId("bb"));
    crash(workerId("bc"));

    // All three crashed events must arrive — none dropped.
    const crashed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<import("@koi/core").WorkerEvent>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined as never }), 100),
        ),
      ]);
      if (!r.done && r.value.kind === "crashed") {
        crashed.push(r.value.workerId);
      }
    }
    crashed.sort();
    expect(crashed).toEqual(["ba", "bb", "bc"]);
  });

  it("delivers events to concurrent subscribers independently", async () => {
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1,
        backoffCeilingMs: 10,
      },
    });
    if (!supervisorResult.ok) return;

    await supervisorResult.value.start(makeRequest("m1"));
    await supervisorResult.value.start(makeRequest("m2"));

    // Two independent subscribers.
    const iterA = supervisorResult.value.watchAll()[Symbol.asyncIterator]() as AsyncIterator<
      import("@koi/core").WorkerEvent
    >;
    const iterB = supervisorResult.value.watchAll()[Symbol.asyncIterator]() as AsyncIterator<
      import("@koi/core").WorkerEvent
    >;

    crash(workerId("m1"));
    crash(workerId("m2"));

    const drain = async (
      iter: AsyncIterator<import("@koi/core").WorkerEvent>,
      n: number,
    ): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<import("@koi/core").WorkerEvent>>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined as never }), 100),
          ),
        ]);
        if (r.done) break;
        if (r.value.kind === "crashed") out.push(r.value.workerId);
      }
      return out.sort();
    };

    // Each subscriber should independently receive both crashed events.
    const [a, b] = await Promise.all([drain(iterA, 4), drain(iterB, 4)]);
    expect(a).toEqual(["m1", "m2"]);
    expect(b).toEqual(["m1", "m2"]);
  });
});

describe("supervisor correctness hardening", () => {
  it("rejects duplicate workerId while worker is live", async () => {
    const { backend } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    const first = await supervisorResult.value.start(makeRequest("dup-1"));
    expect(first.ok).toBe(true);
    const second = await supervisorResult.value.start(makeRequest("dup-1"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");
  });

  it("rejects new start() while supervisor is shutting down", async () => {
    const { backend } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("sd-1"));
    const shutdownPromise = supervisorResult.value.shutdown("test");
    const rejected = await supervisorResult.value.start(makeRequest("sd-2"));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("UNAVAILABLE");
    await shutdownPromise;
  });

  it("does not respawn a worker whose crash fires during shutdown backoff", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      // Fast-restart-transient policy would normally resurrect the worker.
      restart: {
        restart: "transient",
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 50,
        backoffCeilingMs: 50,
      },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("bd-1"));

    // Crash — schedules a restart task that will sleep ~50ms before respawn.
    crash(workerId("bd-1"));

    // Shut down immediately, before the backoff elapses.
    await supervisorResult.value.shutdown("test");

    // Wait enough time for any would-be respawn to have fired, then assert
    // no worker came back.
    await new Promise((r) => setTimeout(r, 150));
    expect(liveWorkerCount()).toBe(0);
    expect(supervisorResult.value.list()).toEqual([]);
  });

  it("stop() waits for observed worker exit, not just terminate RPC return", async () => {
    // Build a backend that resolves terminate() synchronously but never emits
    // an exit event until we tell it to. The shipped subprocess backend has
    // this shape: proc.kill() returns immediately while proc.exited resolves
    // later.
    const events: Array<(ev: WorkerEvent) => void> = [];
    let alive = true;
    const lyingBackend: WorkerBackend = {
      kind: "in-process",
      displayName: "lying",
      isAvailable: () => true,
      spawn: async (req) => {
        const controller = new AbortController();
        // Emit started event through any pending listeners.
        const ev: WorkerEvent = {
          kind: "started",
          workerId: req.workerId,
          at: Date.now(),
        };
        // Deferred so the caller sees the handle first.
        queueMicrotask(() => {
          for (const l of events.splice(0)) l(ev);
        });
        return {
          ok: true,
          value: {
            workerId: req.workerId,
            agentId: req.agentId,
            backendKind: "in-process",
            startedAt: Date.now(),
            signal: controller.signal,
          },
        };
      },
      terminate: async () => {
        // Return ok without actually killing — the bug the reviewer found.
        return { ok: true, value: undefined };
      },
      kill: async (id) => {
        // Force-kill DOES stop the worker and emit exited.
        alive = false;
        queueMicrotask(() => {
          const ev: WorkerEvent = {
            kind: "exited",
            workerId: id,
            at: Date.now(),
            code: 137,
            state: "terminated",
          };
          for (const l of events.splice(0)) l(ev);
        });
        return { ok: true, value: undefined };
      },
      isAlive: async () => alive,
      watch: async function* () {
        while (alive) {
          const ev = await new Promise<WorkerEvent>((resolve) => {
            events.push(resolve);
          });
          yield ev;
          if (ev.kind === "exited" || ev.kind === "crashed") return;
        }
      },
    };

    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 100, // short so the deadline path fires quickly
      backends: { "in-process": lyingBackend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("lying-1"));

    // stop() must not return ok while worker is alive — it should hit the
    // deadline, call kill (which actually exits), and only then return.
    const start = Date.now();
    const result = await supervisorResult.value.stop(workerId("lying-1"), "test");
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    // Elapsed must be at least the shutdown deadline since terminate didn't work.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(alive).toBe(false);
  });

  it("rejects concurrent start() attempts past maxWorkers", async () => {
    // With maxWorkers=1, firing three start() calls in parallel must result in
    // exactly one success. The previous impl checked capacity only against
    // pool.size — multiple callers could pass the check before any of them
    // registered, overshooting the cap.
    const { backend } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 1,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    const results = await Promise.all([
      supervisorResult.value.start(makeRequest("race-1")),
      supervisorResult.value.start(makeRequest("race-2")),
      supervisorResult.value.start(makeRequest("race-3")),
    ]);
    const successes = results.filter((r) => r.ok).length;
    const exhausted = results.filter((r) => !r.ok && r.error.code === "RESOURCE_EXHAUSTED").length;
    expect(successes).toBe(1);
    expect(exhausted).toBe(2);
  });

  it("supervisor remains functional after many subscribers abandon their iterators", async () => {
    // A subscriber that breaks out of its for-await loop or throws leaves a
    // parked waker. The publish-side clears all wakers on every emit, so any
    // abandoned waker reference is dropped at the next publish. This test
    // proves the supervisor keeps serving new subscribers after many such
    // abandonments.
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1,
        backoffCeilingMs: 10,
      },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("leak-1"));

    // Start 25 subscribers that each consume one event (buffered `started`)
    // and then break — leaving the generator at its yield point, not parked
    // on a waker. The finally block evicts nothing but the generator exits
    // cleanly, which is the common real-world abandonment path.
    for (let i = 0; i < 25; i++) {
      const stream = supervisorResult.value.watchAll();
      for await (const _ev of stream) {
        break;
      }
    }

    // New subscriber after all the abandonments must still receive new events.
    const iter = supervisorResult.value.watchAll()[Symbol.asyncIterator]() as AsyncIterator<
      import("@koi/core").WorkerEvent
    >;
    crash(workerId("leak-1"));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<import("@koi/core").WorkerEvent>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined as never }), 100),
        ),
      ]);
      if (r.done) break;
      seen.push(`${r.value.kind}:${r.value.workerId}`);
    }
    expect(seen.some((e) => e === "crashed:leak-1")).toBe(true);
    // Break out cleanly.
    for await (const _ev of (async function* () {})()) void _ev;
  });

  it("shutdown() tears down a worker whose spawn resolves after shuttingDown is set", async () => {
    // A slow backend.spawn() that hasn't resolved yet when shutdown() fires
    // must not admit a surviving worker. The supervisor must terminate the
    // late admission synchronously as part of shutdown.
    type SlowWorker = { terminated: boolean; killed: boolean };
    const spawned: SlowWorker[] = [];
    let releaseSpawn: (() => void) | undefined;
    const slowBackend: WorkerBackend = {
      kind: "in-process",
      displayName: "slow",
      isAvailable: async () => true,
      spawn: async (req) => {
        const w: SlowWorker = { terminated: false, killed: false };
        spawned.push(w);
        // Block until the test releases us.
        await new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });
        return {
          ok: true,
          value: {
            workerId: req.workerId,
            agentId: req.agentId,
            backendKind: "in-process",
            startedAt: Date.now(),
            signal: new AbortController().signal,
          },
        };
      },
      terminate: async () => {
        const w = spawned[spawned.length - 1];
        if (w !== undefined) w.terminated = true;
        return { ok: true, value: undefined };
      },
      kill: async () => {
        const w = spawned[spawned.length - 1];
        if (w !== undefined) w.killed = true;
        return { ok: true, value: undefined };
      },
      isAlive: async () => false,
      watch: async function* (): AsyncIterable<WorkerEvent> {
        // Yield from an empty source — event side not exercised by this test.
        yield* [] as WorkerEvent[];
      },
    };

    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 100,
      backends: { "in-process": slowBackend },
    });
    if (!supervisorResult.ok) return;

    // Fire a spawn that will block in backend.spawn()
    const startPromise = supervisorResult.value.start(makeRequest("late-1"));
    // Give the supervisor a tick to enter the await.
    await new Promise((r) => setTimeout(r, 5));
    // Kick off shutdown — it should see the pending spawn and await it.
    const shutdownPromise = supervisorResult.value.shutdown("test");
    // Another tick so shutdown runs up to its drain.
    await new Promise((r) => setTimeout(r, 5));
    // Now release the spawn — its post-await re-check of shuttingDown should
    // trigger termination of the late admission.
    if (releaseSpawn !== undefined) releaseSpawn();
    const [startResult] = await Promise.all([startPromise, shutdownPromise]);

    expect(startResult.ok).toBe(false);
    if (!startResult.ok) expect(startResult.error.code).toBe("UNAVAILABLE");
    // The late admission must have been terminated.
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.terminated).toBe(true);
    // list() must not contain the late admission.
    expect(supervisorResult.value.list()).toEqual([]);
  });

  it("stop() cancels a worker that is sleeping in restart backoff", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      restart: {
        restart: "transient",
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 200,
        backoffCeilingMs: 200,
      },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("loop-1"));

    // Crash the worker; it enters a 200ms backoff before respawn.
    crash(workerId("loop-1"));
    // Give the supervisor time to observe the crash and schedule the restart.
    await new Promise((r) => setTimeout(r, 20));

    // stop() during backoff must cancel the pending restart.
    const stopResult = await supervisorResult.value.stop(workerId("loop-1"), "test");
    expect(stopResult.ok).toBe(true);

    // Wait past the backoff window — no respawn must have fired.
    await new Promise((r) => setTimeout(r, 300));
    expect(liveWorkerCount()).toBe(0);
    expect(supervisorResult.value.list()).toEqual([]);

    // A fresh start with the same workerId must succeed — activeIds released.
    const restarted = await supervisorResult.value.start(makeRequest("loop-1"));
    expect(restarted.ok).toBe(true);
  });

  it("stop() cancels a worker whose spawn is still awaiting backend.spawn()", async () => {
    type SlowWorker = { terminated: boolean; killed: boolean };
    const spawned: SlowWorker[] = [];
    let releaseSpawn: (() => void) | undefined;
    const slowBackend: WorkerBackend = {
      kind: "in-process",
      displayName: "slow",
      isAvailable: async () => true,
      spawn: async (req) => {
        const w: SlowWorker = { terminated: false, killed: false };
        spawned.push(w);
        await new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });
        return {
          ok: true,
          value: {
            workerId: req.workerId,
            agentId: req.agentId,
            backendKind: "in-process",
            startedAt: Date.now(),
            signal: new AbortController().signal,
          },
        };
      },
      terminate: async () => {
        const w = spawned[spawned.length - 1];
        if (w !== undefined) w.terminated = true;
        return { ok: true, value: undefined };
      },
      kill: async () => {
        const w = spawned[spawned.length - 1];
        if (w !== undefined) w.killed = true;
        return { ok: true, value: undefined };
      },
      isAlive: async () => false,
      watch: async function* (): AsyncIterable<WorkerEvent> {
        yield* [] as WorkerEvent[];
      },
    };

    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 100,
      backends: { "in-process": slowBackend },
    });
    if (!supervisorResult.ok) return;

    const startPromise = supervisorResult.value.start(makeRequest("slow-spawn-1"));
    // Give start() time to reach the await.
    await new Promise((r) => setTimeout(r, 10));
    // stop() during the in-flight spawn must cancel it.
    const stopPromise = supervisorResult.value.stop(workerId("slow-spawn-1"), "test");
    // Let stop() set the cancelled flag, then release the spawn.
    await new Promise((r) => setTimeout(r, 10));
    if (releaseSpawn !== undefined) releaseSpawn();

    const [startResult, stopResult] = await Promise.all([startPromise, stopPromise]);
    expect(startResult.ok).toBe(false);
    if (!startResult.ok) expect(startResult.error.code).toBe("UNAVAILABLE");
    expect(stopResult.ok).toBe(true);
    // The late admission must have been terminated.
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.terminated).toBe(true);
    // list() must be clean; activeIds must be released.
    expect(supervisorResult.value.list()).toEqual([]);
    // Starting a fresh worker with the same id must now succeed.
    if (releaseSpawn !== undefined) {
      // Reset the release gate for the next spawn.
      releaseSpawn = undefined;
    }
  });

  it("falls back to an available backend when the preferred one declares itself unavailable", async () => {
    const { backend: subprocess } = createFakeBackend("subprocess");
    const { backend: inProcess } = createFakeBackend("in-process");
    // Override subprocess.isAvailable to return false.
    const unavailableSubprocess: WorkerBackend = {
      ...subprocess,
      isAvailable: async () => false,
    };
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { subprocess: unavailableSubprocess, "in-process": inProcess },
    });
    if (!supervisorResult.ok) return;
    const started = await supervisorResult.value.start(makeRequest("fb-1"));
    expect(started.ok).toBe(true);
    // Must have fallen back to in-process, not attempted subprocess.
    if (started.ok) expect(started.value.backendKind).toBe("in-process");
  });

  it("bounds the event buffer under sustained crash/restart churn", async () => {
    // Prior impl grew eventBuffer forever. With a bounded ring buffer, a
    // long-lived supervisor emitting thousands of events must not OOM.
    // We can't assert memory directly, but we CAN assert:
    //   - watchAll continues to deliver recent events
    //   - list()/stop() still function after heavy churn
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
      // Permanent restart with no backoff — drives aggressive churn.
      restart: {
        restart: "permanent",
        maxRestarts: 9999,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 0,
        backoffCeilingMs: 0,
      },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("churn-1"));

    // Fire many crashes. Each triggers restart → started event → eligible for
    // another crash. This alone can publish thousands of events.
    for (let i = 0; i < 200; i++) {
      crash(workerId("churn-1"));
      // Yield so the respawn actually registers before the next crash.
      await new Promise((r) => setTimeout(r, 0));
    }

    // Subscriber coming in AFTER all the churn should still receive the next
    // event without hanging — proves the buffer is still wired to wakers.
    const iter = supervisorResult.value.watchAll()[Symbol.asyncIterator]() as AsyncIterator<
      import("@koi/core").WorkerEvent
    >;
    // Drain any currently-buffered events.
    for (let i = 0; i < 10; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<import("@koi/core").WorkerEvent>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined as never }), 10),
        ),
      ]);
      if (r.done) break;
    }
    if (iter.return !== undefined) await iter.return(undefined);

    // Shutdown must still work after the churn storm.
    const sd = await supervisorResult.value.shutdown("test");
    expect(sd.ok).toBe(true);
  });
});
