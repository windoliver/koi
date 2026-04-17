import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerRestartPolicy, WorkerSpawnRequest } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createSupervisor } from "../create-supervisor.js";
import { createFakeBackend } from "./fake-backend.js";

const fastPolicy: WorkerRestartPolicy = {
  restart: "transient",
  maxRestarts: 3,
  maxRestartWindowMs: 60_000,
  backoffBaseMs: 1,
  backoffCeilingMs: 10,
};

const makeRequest = (id: string): WorkerSpawnRequest => ({
  workerId: workerId(id),
  agentId: agentId(`agent-${id}`),
  command: ["echo", "hi"],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("restart policy", () => {
  it("restarts transient workers on crash", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: fastPolicy,
    };
    const sup = createSupervisor(config);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    crash(workerId("w1"));
    await sleep(50);
    expect(liveWorkerCount()).toBeGreaterThan(0);
  });

  it("does not restart temporary workers", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: { ...fastPolicy, restart: "temporary" },
    };
    const sup = createSupervisor(config);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    crash(workerId("w1"));
    await sleep(50);
    expect(liveWorkerCount()).toBe(0);
  });

  it("stops restarting after maxRestarts in window", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: { ...fastPolicy, maxRestarts: 2 },
    };
    const sup = createSupervisor(config);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    for (let i = 0; i < 5; i++) {
      crash(workerId("w1"));
      await sleep(20);
    }
    // After maxRestarts exhausted, the last crash leaves the worker dead.
    expect(liveWorkerCount()).toBe(0);
  });
});
