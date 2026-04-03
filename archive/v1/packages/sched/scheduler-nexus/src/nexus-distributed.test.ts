/**
 * Distributed scheduling scenario tests using fake-nexus-fetch.
 *
 * 5 focused scenarios with deterministic mocking:
 * 1. Concurrent claim — two nodes get disjoint tasks
 * 2. Visibility timeout — claimed task auto-returns after expiry
 * 3. Nack → re-claim cycle
 * 4. Idempotent enqueue — same key returns same ID
 * 5. Cron tick dedup — only one node wins
 */

import { describe, expect, test } from "bun:test";
import type { ScheduledTask, TaskQueueBackend } from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createNexusTaskQueue } from "./nexus-queue.js";
import { createNexusTaskStore } from "./nexus-task-store.js";
import type { NexusSchedulerConfig } from "./scheduler-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: taskId("task_1"),
    agentId: agentId("agent_1"),
    input: { kind: "text", text: "hello" },
    mode: "spawn",
    priority: 5,
    status: "pending",
    createdAt: 1000,
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

/** Assert that the optional distributed methods exist and return typed references. */
function assertDistributed(queue: TaskQueueBackend): {
  readonly claim: NonNullable<TaskQueueBackend["claim"]>;
  readonly ack: NonNullable<TaskQueueBackend["ack"]>;
  readonly nack: NonNullable<TaskQueueBackend["nack"]>;
  readonly tick: NonNullable<TaskQueueBackend["tick"]>;
} {
  if (
    queue.claim === undefined ||
    queue.ack === undefined ||
    queue.nack === undefined ||
    queue.tick === undefined
  ) {
    throw new Error("Expected distributed methods to be defined");
  }
  return { claim: queue.claim, ack: queue.ack, nack: queue.nack, tick: queue.tick };
}

function createTestSetup(): {
  readonly config: NexusSchedulerConfig;
  readonly queue: TaskQueueBackend;
  readonly store: ReturnType<typeof createNexusTaskStore>;
} {
  const fakeFetch = createFakeNexusFetch();
  const config: NexusSchedulerConfig = {
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    visibilityTimeoutMs: 5_000,
    fetch: fakeFetch,
  };
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: fakeFetch,
  });
  const queue = createNexusTaskQueue(config);
  const store = createNexusTaskStore(client);
  return { config, queue, store };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("Distributed scheduling scenarios", () => {
  test("1. Concurrent claim: two nodes get disjoint tasks", async () => {
    const { queue, store } = createTestSetup();
    const { claim } = assertDistributed(queue);

    // Enqueue 4 tasks
    const tasks = [
      makeTask({ id: taskId("t1"), priority: 1 }),
      makeTask({ id: taskId("t2"), priority: 2 }),
      makeTask({ id: taskId("t3"), priority: 3 }),
      makeTask({ id: taskId("t4"), priority: 4 }),
    ];
    for (const task of tasks) {
      await store.save(task);
    }

    // Node A claims 2
    const nodeAClaimed = await claim("node-a", 2);
    expect(nodeAClaimed).toHaveLength(2);

    // Node B claims 2
    const nodeBClaimed = await claim("node-b", 2);
    expect(nodeBClaimed).toHaveLength(2);

    // No overlap — disjoint IDs
    const aIds = new Set(nodeAClaimed.map((t) => t.id));
    const bIds = new Set(nodeBClaimed.map((t) => t.id));
    for (const bId of bIds) {
      expect(aIds.has(bId)).toBe(false);
    }
  });

  test("2. Visibility timeout: claimed task auto-returns after expiry", async () => {
    const fakeFetch = createFakeNexusFetch();
    const config: NexusSchedulerConfig = {
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      visibilityTimeoutMs: 1, // 1ms — will expire nearly immediately
      fetch: fakeFetch,
    };
    const client = createNexusClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetch: fakeFetch,
    });
    const queue = createNexusTaskQueue(config);
    const store = createNexusTaskStore(client);
    const { claim } = assertDistributed(queue);

    await store.save(makeTask({ id: taskId("timeout_task") }));

    // Node A claims
    const claimed = await claim("node-a", 1);
    expect(claimed).toHaveLength(1);

    // Wait for visibility timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Node B should be able to re-claim the expired task
    const reClaimed = await claim("node-b", 1);
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0]?.id).toBe(taskId("timeout_task"));
  });

  test("3. Nack → re-claim cycle: nacked task becomes claimable again", async () => {
    const { queue, store } = createTestSetup();
    const { claim, nack } = assertDistributed(queue);

    await store.save(makeTask({ id: taskId("nack_task") }));

    // Node A claims
    const claimed = await claim("node-a", 1);
    expect(claimed).toHaveLength(1);

    // Node A nacks the task
    const nackResult = await nack(taskId("nack_task"), "transient error");
    expect(nackResult).toBe(true);

    // Node B should be able to claim it
    const reClaimed = await claim("node-b", 1);
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0]?.id).toBe(taskId("nack_task"));
  });

  test("4. Ack marks task as completed", async () => {
    const { queue, store } = createTestSetup();
    const { claim, ack } = assertDistributed(queue);

    await store.save(makeTask({ id: taskId("ack_task") }));

    // Claim and ack
    const claimed = await claim("node-a", 1);
    expect(claimed).toHaveLength(1);

    const ackResult = await ack(taskId("ack_task"), { output: "done" });
    expect(ackResult).toBe(true);

    // Task should no longer be claimable
    const empty = await claim("node-b", 10);
    expect(empty).toHaveLength(0);
  });

  test("5. Cron tick dedup: only one node wins per tick window", async () => {
    const { queue } = createTestSetup();
    const { tick } = assertDistributed(queue);

    const sid = scheduleId("sched_cron_1");

    // First node claims the tick
    const firstTick = await tick(sid, "node-a");
    expect(firstTick).toBe(true);

    // Second node loses (same tick window)
    const secondTick = await tick(sid, "node-b");
    expect(secondTick).toBe(false);
  });
});
