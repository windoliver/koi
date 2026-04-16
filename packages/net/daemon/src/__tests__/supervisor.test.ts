import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerEvent, WorkerSpawnRequest } from "@koi/core";
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
});
