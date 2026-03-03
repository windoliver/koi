/**
 * Multi-session integration tests — full lifecycle across sessions.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  EngineMetrics,
  HarnessSnapshotStore,
  SessionPersistence,
  SessionRecord,
  TaskBoardSnapshot,
} from "@koi/core";
import { agentId, chainId, harnessId, taskItemId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { assertOk } from "@koi/test-utils";
import { createLongRunningHarness } from "../harness.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("integration-harness");
const TEST_AGENT_ID = agentId("agent-integration");
const TEST_CHAIN_ID = chainId(TEST_HARNESS_ID);

const METRICS: EngineMetrics = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  turns: 5,
  durationMs: 3000,
};

function createPlan(): TaskBoardSnapshot {
  return {
    items: [
      {
        id: taskItemId("task-A"),
        description: "Task A",
        dependencies: [],
        priority: 0,
        maxRetries: 3,
        retries: 0,
        status: "pending" as const,
      },
      {
        id: taskItemId("task-B"),
        description: "Task B",
        dependencies: [],
        priority: 1,
        maxRetries: 3,
        retries: 0,
        status: "pending" as const,
      },
      {
        id: taskItemId("task-C"),
        description: "Task C",
        dependencies: [],
        priority: 2,
        maxRetries: 3,
        retries: 0,
        status: "pending" as const,
      },
    ],
    results: [],
  };
}

function createMockPersistence(): SessionPersistence & {
  readonly savedSessions: Map<string, SessionRecord>;
} {
  const savedSessions = new Map<string, SessionRecord>();

  return {
    savedSessions,
    saveSession: (record: SessionRecord) => {
      savedSessions.set(record.sessionId, record);
      return { ok: true as const, value: undefined };
    },
    loadSession: (sessionId: string) => {
      const record = savedSessions.get(sessionId);
      if (record) {
        return { ok: true as const, value: record };
      }
      return {
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
      };
    },
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-session integration", () => {
  let store: HarnessSnapshotStore;
  let persistence: ReturnType<typeof createMockPersistence>;

  beforeEach(() => {
    store = createInMemorySnapshotChainStore();
    persistence = createMockPersistence();
  });

  test("full lifecycle: start → session 1 → pause → resume → session 2 → completed", async () => {
    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    // Start with plan
    const startResult = await harness.start(createPlan());
    assertOk(startResult);
    expect(startResult.value.engineInput.kind).toBe("text");

    // Complete task A during session 1
    const completeA = await harness.completeTask(taskItemId("task-A"), {
      taskId: taskItemId("task-A"),
      output: "Done A",
      durationMs: 500,
    });
    assertOk(completeA);
    expect(harness.status().phase).toBe("active");

    // Pause session 1
    const pauseResult = await harness.pause({
      sessionId: startResult.value.sessionId,
      metrics: METRICS,
      summary: "Completed task A, B and C remain",
    });
    assertOk(pauseResult);
    expect(harness.status().phase).toBe("suspended");

    // Resume for session 2
    const resumeResult = await harness.resume();
    assertOk(resumeResult);
    expect(resumeResult.value.engineInput.kind).toBe("messages");

    // Complete tasks B and C during session 2
    const completeB = await harness.completeTask(taskItemId("task-B"), {
      taskId: taskItemId("task-B"),
      output: "Done B",
      durationMs: 500,
    });
    assertOk(completeB);

    const completeC = await harness.completeTask(taskItemId("task-C"), {
      taskId: taskItemId("task-C"),
      output: "Done C",
      durationMs: 500,
    });
    assertOk(completeC);

    // All tasks done → completed
    expect(harness.status().phase).toBe("completed");
    expect(harness.status().metrics.totalSessions).toBe(1);
    expect(harness.status().metrics.completedTaskCount).toBe(3);
  });

  test("resume without engine state falls back to messages", async () => {
    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    await harness.start(createPlan());
    await harness.pause({ sessionId: "s-1", metrics: METRICS });

    // No engine state set on persistence
    const result = await harness.resume();
    assertOk(result);
    expect(result.value.engineStateRecovered).toBe(false);
    expect(result.value.engineInput.kind).toBe("messages");
  });

  test("snapshot chain grows across sessions", async () => {
    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    await harness.start(createPlan());
    // Snapshot 1: start

    await harness.pause({ sessionId: "s-1", metrics: METRICS, summary: "Session 1" });
    // Snapshot 2: pause

    await harness.resume();
    // Snapshot 3: resume

    await harness.pause({ sessionId: "s-2", metrics: METRICS, summary: "Session 2" });
    // Snapshot 4: pause again

    const listResult = await store.list(TEST_CHAIN_ID);
    assertOk(listResult);
    expect(listResult.value.length).toBeGreaterThanOrEqual(4);
  });
});
