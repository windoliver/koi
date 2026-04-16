import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerSpawnRequest } from "@koi/core";
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
