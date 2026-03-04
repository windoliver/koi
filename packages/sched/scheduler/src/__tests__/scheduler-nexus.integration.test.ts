/**
 * Integration test: Scheduler distributed poll loop + Nexus backends.
 *
 * Verifies that the distributed poll loop correctly claims tasks from
 * a Nexus backend and dispatches them via the task dispatcher.
 *
 * Uses NexusTaskStore (JSON-RPC) to stage tasks, then the scheduler's
 * distributed poll loop claims and executes them.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, EngineInput, ScheduledTask, SchedulerConfig } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG, taskId } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import type { NexusSchedulerConfig } from "@koi/scheduler-nexus";
import {
  createNexusScheduleStore,
  createNexusTaskQueue,
  createNexusTaskStore,
} from "@koi/scheduler-nexus";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createSystemClock } from "../clock.js";
import type { TaskDispatcher } from "../scheduler.js";
import { createScheduler } from "../scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: taskId("task_int_1"),
    agentId: agentId("agent_1"),
    input: { kind: "text", text: "integration" },
    mode: "spawn",
    priority: 5,
    status: "pending",
    createdAt: Date.now(),
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createIntegrationSetup(): {
  readonly dispatcherMock: ReturnType<typeof mock<TaskDispatcher>>;
  readonly config: SchedulerConfig;
  readonly store: ReturnType<typeof createNexusTaskStore>;
  readonly scheduleStore: ReturnType<typeof createNexusScheduleStore>;
  readonly queue: ReturnType<typeof createNexusTaskQueue>;
} {
  const fakeFetch = createFakeNexusFetch();
  const nexusConfig: NexusSchedulerConfig = {
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    visibilityTimeoutMs: 30_000,
    fetch: fakeFetch,
  };

  const client = createNexusClient({
    baseUrl: nexusConfig.baseUrl,
    apiKey: nexusConfig.apiKey,
    fetch: fakeFetch,
  });

  const dispatcherMock = mock<TaskDispatcher>(
    async (_aid: AgentId, _input: EngineInput, _mode: "spawn" | "dispatch") => "dispatched",
  );

  return {
    dispatcherMock,
    config: {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 50,
      maxConcurrent: 5,
    },
    store: createNexusTaskStore(client),
    scheduleStore: createNexusScheduleStore(client),
    queue: createNexusTaskQueue(nexusConfig),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduler + Nexus distributed integration", () => {
  let disposeFn: (() => PromiseLike<void>) | undefined;

  afterEach(async () => {
    if (disposeFn !== undefined) {
      await disposeFn();
      disposeFn = undefined;
    }
  });

  test("distributed poll claims and dispatches pre-staged tasks", async () => {
    const { dispatcherMock, config, store, scheduleStore, queue } = createIntegrationSetup();

    // Stage a task directly in the Nexus store (bypassing scheduler.submit REST path)
    const task = makeTask({ id: taskId("pre_staged_1") });
    await store.save(task);

    // Create scheduler with distributed backend — the poll loop will claim this task
    const scheduler = createScheduler(
      config,
      store,
      dispatcherMock,
      createSystemClock(),
      scheduleStore,
      queue,
      "test-node-1",
    );
    disposeFn = () => scheduler[Symbol.asyncDispose]();

    // Wait for the adaptive poll to fire (pollIntervalMs=50, add buffer)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify: dispatcher was called with the pre-staged task's agent and input
    expect(dispatcherMock).toHaveBeenCalled();
    const [calledAgentId, calledInput, calledMode] = dispatcherMock.mock.calls[0] ?? [];
    expect(calledAgentId).toBe(agentId("agent_1"));
    expect(calledInput).toEqual({ kind: "text", text: "integration" });
    expect(calledMode).toBe("spawn");
  });

  test("multiple tasks are claimed up to concurrency limit", async () => {
    const { dispatcherMock, config, store, scheduleStore, queue } = createIntegrationSetup();

    // Stage 3 tasks
    for (let i = 0; i < 3; i++) {
      await store.save(makeTask({ id: taskId(`batch_${String(i)}`), priority: i }));
    }

    const scheduler = createScheduler(
      config,
      store,
      dispatcherMock,
      createSystemClock(),
      scheduleStore,
      queue,
      "test-node-2",
    );
    disposeFn = () => scheduler[Symbol.asyncDispose]();

    await new Promise((resolve) => setTimeout(resolve, 300));

    // All 3 tasks should have been dispatched
    expect(dispatcherMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("stats reflect scheduler state", async () => {
    const { dispatcherMock, config, store, scheduleStore, queue } = createIntegrationSetup();

    const scheduler = createScheduler(
      config,
      store,
      dispatcherMock,
      createSystemClock(),
      scheduleStore,
      queue,
      "stats-node",
    );
    disposeFn = () => scheduler[Symbol.asyncDispose]();

    const stats = scheduler.stats();
    // In distributed mode, local pending = 0 (Nexus owns the queue)
    expect(stats.pending).toBe(0);
    expect(stats.activeSchedules).toBe(0);
  });
});
