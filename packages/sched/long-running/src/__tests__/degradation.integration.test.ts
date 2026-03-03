/**
 * Degradation integration tests — edge cases and error recovery.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  EngineMetrics,
  HarnessSnapshotStore,
  SessionPersistence,
  TaskBoardSnapshot,
} from "@koi/core";
import { agentId, harnessId, taskItemId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { assertErr, assertOk } from "@koi/test-utils";
import { createLongRunningHarness } from "../harness.js";
import type { LongRunningConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("degradation-harness");
const TEST_AGENT_ID = agentId("agent-degradation");

const METRICS: EngineMetrics = {
  totalTokens: 50,
  inputTokens: 30,
  outputTokens: 20,
  turns: 2,
  durationMs: 1000,
};

function createPlan(count = 2): TaskBoardSnapshot {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: taskItemId(`task-${String(i + 1)}`),
      description: `Task ${String(i + 1)}`,
      dependencies: [],
      priority: i,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    })),
    results: [],
  };
}

function createMockPersistence(): SessionPersistence {
  return {
    saveSession: () => ({ ok: true as const, value: undefined }),
    loadSession: () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    }),
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

function createHarness(
  store: HarnessSnapshotStore,
  overrides?: Partial<LongRunningConfig>,
): ReturnType<typeof createLongRunningHarness> {
  return createLongRunningHarness({
    harnessId: TEST_HARNESS_ID,
    agentId: TEST_AGENT_ID,
    harnessStore: store,
    sessionPersistence: createMockPersistence(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("degradation", () => {
  let store: HarnessSnapshotStore;

  beforeEach(() => {
    store = createInMemorySnapshotChainStore();
  });

  test("pause without summary omits context summary", async () => {
    const harness = createHarness(store);
    await harness.start(createPlan());
    const result = await harness.pause({
      sessionId: "s-1",
      metrics: METRICS,
      // No summary
    });
    assertOk(result);
    expect(harness.status().phase).toBe("suspended");
  });

  test("all-completed plan transitions to completed on last task", async () => {
    const harness = createHarness(store);
    await harness.start(createPlan(1));

    const result = await harness.completeTask(taskItemId("task-1"), {
      taskId: taskItemId("task-1"),
      output: "Done",
      durationMs: 100,
    });
    assertOk(result);
    expect(harness.status().phase).toBe("completed");
  });

  test("concurrent resume on same harness fails (second call sees active phase)", async () => {
    const harness = createHarness(store);
    await harness.start(createPlan());
    await harness.pause({ sessionId: "s-1", metrics: METRICS });

    // First resume succeeds
    const r1 = await harness.resume();
    assertOk(r1);

    // Second resume fails — now active
    const r2 = await harness.resume();
    assertErr(r2);
    expect(r2.error.code).toBe("VALIDATION");
  });

  test("dispose prevents start", async () => {
    const harness = createHarness(store);
    await harness.dispose();
    const result = await harness.start(createPlan());
    assertErr(result);
  });

  test("dispose prevents resume", async () => {
    const harness = createHarness(store);
    await harness.start(createPlan());
    await harness.pause({ sessionId: "s-1", metrics: METRICS });
    await harness.dispose();
    const result = await harness.resume();
    assertErr(result);
  });

  test("dispose prevents completeTask", async () => {
    const harness = createHarness(store);
    await harness.start(createPlan());
    await harness.dispose();
    const result = await harness.completeTask(taskItemId("task-1"), {
      taskId: taskItemId("task-1"),
      output: "Done",
      durationMs: 100,
    });
    assertErr(result);
  });
});
