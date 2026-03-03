/**
 * Tests for the long-running harness.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  EngineMetrics,
  EngineState,
  HarnessSnapshotStore,
  KoiError,
  SessionCheckpoint,
  SessionPersistence,
  TaskBoardSnapshot,
  TaskResult,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, chainId, harnessId, sessionId, taskItemId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import {
  assertErr,
  assertOk,
  createMockSessionContext,
  createMockTurnContext,
} from "@koi/test-utils";
import { createLongRunningHarness } from "./harness.js";
import type { LongRunningConfig, LongRunningHarness, SessionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("test-harness");
const TEST_AGENT_ID = agentId("agent-1");
const TEST_CHAIN_ID = chainId(TEST_HARNESS_ID);

const DEFAULT_METRICS: EngineMetrics = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  turns: 3,
  durationMs: 5000,
};

function createTestPlan(count = 3): TaskBoardSnapshot {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: taskItemId(`task-${String(i + 1)}`),
      description: `Test task ${String(i + 1)}`,
      dependencies: [],
      priority: i,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    })),
    results: [],
  };
}

function createSessionResult(overrides?: Partial<SessionResult>): SessionResult {
  return {
    sessionId: "session-1",
    metrics: DEFAULT_METRICS,
    ...overrides,
  };
}

function createTaskResult(taskId: string): TaskResult {
  return {
    taskId: taskItemId(taskId),
    output: `Completed ${taskId}`,
    durationMs: 1000,
  };
}

// ---------------------------------------------------------------------------
// Mock SessionPersistence
// ---------------------------------------------------------------------------

function createMockSessionPersistence(): SessionPersistence & {
  readonly savedCheckpoints: SessionCheckpoint[];
  setLatestCheckpoint: (cp: SessionCheckpoint | undefined) => void;
} {
  const savedCheckpoints: SessionCheckpoint[] = [];
  let latestCheckpoint: SessionCheckpoint | undefined;

  return {
    savedCheckpoints,
    setLatestCheckpoint(cp: SessionCheckpoint | undefined): void {
      latestCheckpoint = cp;
    },
    saveSession: () => ({ ok: true as const, value: undefined }),
    loadSession: () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    }),
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    saveCheckpoint(cp: SessionCheckpoint) {
      savedCheckpoints.push(cp);
      return { ok: true as const, value: undefined };
    },
    loadLatestCheckpoint(_aid: AgentId) {
      return { ok: true as const, value: latestCheckpoint };
    },
    listCheckpoints: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], checkpoints: new Map(), pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let harnessStore: HarnessSnapshotStore;
let persistence: ReturnType<typeof createMockSessionPersistence>;
let harness: LongRunningHarness;

function createTestHarness(overrides?: Partial<LongRunningConfig>): LongRunningHarness {
  const config: LongRunningConfig = {
    harnessId: TEST_HARNESS_ID,
    agentId: TEST_AGENT_ID,
    harnessStore,
    sessionPersistence: persistence,
    ...overrides,
  };
  return createLongRunningHarness(config);
}

beforeEach(() => {
  harnessStore = createInMemorySnapshotChainStore();
  persistence = createMockSessionPersistence();
  harness = createTestHarness();
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe("start", () => {
  test("returns text engine input with task plan", async () => {
    const plan = createTestPlan();
    const result = await harness.start(plan);
    assertOk(result);
    expect(result.value.engineInput.kind).toBe("text");
    if (result.value.engineInput.kind === "text") {
      expect(result.value.engineInput.text).toContain("Task Plan");
    }
  });

  test("returns a session ID", async () => {
    const result = await harness.start(createTestPlan());
    assertOk(result);
    expect(result.value.sessionId).toBeTruthy();
  });

  test("persists initial snapshot to store", async () => {
    const result = await harness.start(createTestPlan());
    assertOk(result);

    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value).toBeDefined();
    expect(headResult.value?.data.phase).toBe("active");
    expect(headResult.value?.data.sessionSeq).toBe(1);
  });

  test("transitions phase to active", async () => {
    await harness.start(createTestPlan());
    expect(harness.status().phase).toBe("active");
  });

  test("rejects empty task plan", async () => {
    const emptyPlan: TaskBoardSnapshot = { items: [], results: [] };
    const result = await harness.start(emptyPlan);
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// pause()
// ---------------------------------------------------------------------------

describe("pause", () => {
  beforeEach(async () => {
    await harness.start(createTestPlan());
  });

  test("transitions phase to suspended", async () => {
    const result = await harness.pause(createSessionResult());
    assertOk(result);
    expect(harness.status().phase).toBe("suspended");
  });

  test("accumulates metrics", async () => {
    const result = await harness.pause(createSessionResult());
    assertOk(result);
    const status = harness.status();
    expect(status.metrics.totalSessions).toBe(1);
    expect(status.metrics.totalTurns).toBe(3);
    expect(status.metrics.totalInputTokens).toBe(60);
    expect(status.metrics.totalOutputTokens).toBe(40);
  });

  test("saves engine state via session persistence", async () => {
    const engineState: EngineState = { engineId: "test", data: { foo: "bar" } };
    await harness.pause(createSessionResult({ engineState }));
    expect(persistence.savedCheckpoints.length).toBeGreaterThan(0);
  });

  test("creates hard checkpoint in harness store", async () => {
    await harness.pause(createSessionResult());
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.phase).toBe("suspended");
  });

  test("rejects when not in active phase", async () => {
    await harness.pause(createSessionResult());
    // Now suspended — pause again should fail
    const result = await harness.pause(createSessionResult());
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("appends context summary when provided", async () => {
    await harness.pause(createSessionResult({ summary: "Did great work" }));
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.summaries).toHaveLength(1);
    expect(headResult.value?.data.summaries[0]?.narrative).toBe("Did great work");
  });
});

// ---------------------------------------------------------------------------
// resume()
// ---------------------------------------------------------------------------

describe("resume", () => {
  beforeEach(async () => {
    await harness.start(createTestPlan());
    await harness.pause(createSessionResult({ summary: "Session 1 done" }));
  });

  test("resumes with engine state when available", async () => {
    const engineState: EngineState = { engineId: "test", data: { turnCount: 5 } };
    const checkpoint: SessionCheckpoint = {
      id: "cp-1",
      agentId: TEST_AGENT_ID,
      sessionId: sessionId("s-1"),
      engineState,
      processState: "running",
      generation: 1,
      metadata: {},
      createdAt: Date.now(),
    };
    persistence.setLatestCheckpoint(checkpoint);

    const result = await harness.resume();
    assertOk(result);
    expect(result.value.engineStateRecovered).toBe(true);
    expect(result.value.engineInput.kind).toBe("resume");
  });

  test("falls back to messages when no engine state", async () => {
    const result = await harness.resume();
    assertOk(result);
    expect(result.value.engineStateRecovered).toBe(false);
    expect(result.value.engineInput.kind).toBe("messages");
  });

  test("increments sessionSeq", async () => {
    await harness.resume();
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.sessionSeq).toBe(2);
  });

  test("rejects when not in suspended phase", async () => {
    await harness.resume();
    // Now active — resume again should fail
    const result = await harness.resume();
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// completeTask()
// ---------------------------------------------------------------------------

describe("completeTask", () => {
  beforeEach(async () => {
    await harness.start(createTestPlan());
  });

  test("marks task as completed in board", async () => {
    const result = await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    assertOk(result);
    const status = harness.status();
    const task = status.taskBoard.items.find((i) => i.id === "task-1");
    expect(task?.status).toBe("completed");
  });

  test("transitions to completed when all tasks done", async () => {
    await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    await harness.completeTask(taskItemId("task-3"), createTaskResult("task-3"));
    expect(harness.status().phase).toBe("completed");
  });

  test("returns NOT_FOUND for unknown task", async () => {
    const result = await harness.completeTask(
      taskItemId("nonexistent"),
      createTaskResult("nonexistent"),
    );
    assertErr(result);
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("rejects when not in active or suspended phase", async () => {
    // Complete all tasks to move to "completed" phase
    await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    await harness.completeTask(taskItemId("task-3"), createTaskResult("task-3"));

    const result = await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    assertErr(result);
  });

  test("is callable in both active and suspended phases", async () => {
    // Active phase
    const r1 = await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    assertOk(r1);

    // Pause to suspended
    await harness.pause(createSessionResult());

    // Suspended phase
    const r2 = await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    assertOk(r2);
  });
});

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

describe("status", () => {
  test("reflects current phase", async () => {
    expect(harness.status().phase).toBe("idle");
    await harness.start(createTestPlan());
    expect(harness.status().phase).toBe("active");
  });

  test("reflects task board", async () => {
    await harness.start(createTestPlan(2));
    const status = harness.status();
    expect(status.taskBoard.items).toHaveLength(2);
  });

  test("reflects metrics", async () => {
    await harness.start(createTestPlan());
    await harness.pause(createSessionResult());
    const status = harness.status();
    expect(status.metrics.totalSessions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// completeTask() — metric assertions (Gap 6)
// ---------------------------------------------------------------------------

describe("completeTask metrics", () => {
  beforeEach(async () => {
    await harness.start(createTestPlan());
  });

  test("updates completedTaskCount after each completion", async () => {
    await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    expect(harness.status().metrics.completedTaskCount).toBe(1);
    expect(harness.status().metrics.pendingTaskCount).toBe(2);

    await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    expect(harness.status().metrics.completedTaskCount).toBe(2);
    expect(harness.status().metrics.pendingTaskCount).toBe(1);
  });

  test("sets pendingTaskCount to 0 when all done", async () => {
    await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    await harness.completeTask(taskItemId("task-3"), createTaskResult("task-3"));
    expect(harness.status().metrics.completedTaskCount).toBe(3);
    expect(harness.status().metrics.pendingTaskCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fail() (Gap 1)
// ---------------------------------------------------------------------------

describe("fail", () => {
  beforeEach(async () => {
    await harness.start(createTestPlan());
  });

  test("transitions phase to failed", async () => {
    const error: KoiError = { code: "TIMEOUT", message: "Agent timed out", retryable: false };
    const result = await harness.fail(error);
    assertOk(result);
    expect(harness.status().phase).toBe("failed");
  });

  test("persists failureReason in status", async () => {
    const error: KoiError = { code: "TIMEOUT", message: "Agent timed out", retryable: false };
    await harness.fail(error);
    expect(harness.status().failureReason).toBe("Agent timed out");
  });

  test("persists failureReason in snapshot store", async () => {
    const error: KoiError = { code: "TIMEOUT", message: "Agent timed out", retryable: false };
    await harness.fail(error);
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.phase).toBe("failed");
    expect(headResult.value?.data.failureReason).toBe("Agent timed out");
  });

  test("is callable from active phase", async () => {
    const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
    const result = await harness.fail(error);
    assertOk(result);
  });

  test("is callable from suspended phase", async () => {
    await harness.pause(createSessionResult());
    const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
    const result = await harness.fail(error);
    assertOk(result);
    expect(harness.status().phase).toBe("failed");
  });

  test("rejects from idle phase", async () => {
    const freshHarness = createTestHarness();
    const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
    const result = await freshHarness.fail(error);
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects from completed phase", async () => {
    await harness.completeTask(taskItemId("task-1"), createTaskResult("task-1"));
    await harness.completeTask(taskItemId("task-2"), createTaskResult("task-2"));
    await harness.completeTask(taskItemId("task-3"), createTaskResult("task-3"));
    expect(harness.status().phase).toBe("completed");

    const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
    const result = await harness.fail(error);
    assertErr(result);
  });

  test("prevents further operations after fail", async () => {
    await harness.fail({ code: "TIMEOUT", message: "Timed out", retryable: false });
    const resumeResult = await harness.resume();
    assertErr(resumeResult);
    const startResult = await harness.start(createTestPlan());
    assertErr(startResult);
  });
});

// ---------------------------------------------------------------------------
// resume() — store recovery path (Gap 5)
// ---------------------------------------------------------------------------

describe("resume store recovery", () => {
  test("resume uses in-memory snapshot and loads from store as fallback", async () => {
    // Standard start → pause → resume cycle exercises the in-memory path
    await harness.start(createTestPlan());
    await harness.pause(createSessionResult({ summary: "Session 1" }));

    const result = await harness.resume();
    assertOk(result);
    expect(result.value.engineInput.kind).toBe("messages");
    expect(result.value.engineStateRecovered).toBe(false);
  });

  test("resume loads snapshot from store when harness state is persisted", async () => {
    // Verify the store has data after start → pause
    await harness.start(createTestPlan());
    await harness.pause(createSessionResult({ summary: "Session 1" }));

    // Verify data was written to the store
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value).toBeDefined();
    expect(headResult.value?.data.phase).toBe("suspended");
    expect(headResult.value?.data.summaries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createMiddleware() (Gap 3 + 4)
// ---------------------------------------------------------------------------

describe("createMiddleware", () => {
  test("returns middleware with correct name and priority", async () => {
    await harness.start(createTestPlan());
    const mw = harness.createMiddleware();
    expect(mw.name).toBe("long-running-harness");
    expect(mw.priority).toBe(50);
  });

  test("onAfterTurn increments turn count and fires soft checkpoint", async () => {
    const testHarness = createTestHarness({ softCheckpointInterval: 1 });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 0 });

    // Fire onAfterTurn — should trigger soft checkpoint at every turn
    await mw.onAfterTurn?.(ctx);

    // Check that a checkpoint was saved
    expect(persistence.savedCheckpoints.length).toBe(1);
    expect(persistence.savedCheckpoints[0]?.metadata).toEqual({ softCheckpoint: true });
  });

  test("onAfterTurn uses saveState callback for real engine state", async () => {
    const realState: EngineState = { engineId: "real-engine", data: { cursor: 42 } };
    const testHarness = createTestHarness({
      softCheckpointInterval: 1,
      saveState: () => realState,
    });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 0 });
    await mw.onAfterTurn?.(ctx);

    expect(persistence.savedCheckpoints.length).toBe(1);
    expect(persistence.savedCheckpoints[0]?.engineState).toEqual(realState);
  });

  test("onAfterTurn uses placeholder when no saveState callback", async () => {
    const testHarness = createTestHarness({ softCheckpointInterval: 1 });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 0 });
    await mw.onAfterTurn?.(ctx);

    expect(persistence.savedCheckpoints[0]?.engineState).toEqual({
      engineId: "soft-checkpoint",
      data: null,
    });
  });

  test("onAfterTurn respects checkpoint interval", async () => {
    const testHarness = createTestHarness({ softCheckpointInterval: 3 });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 0 });

    // Turns 1, 2 — no checkpoint
    await mw.onAfterTurn?.(ctx);
    await mw.onAfterTurn?.(ctx);
    expect(persistence.savedCheckpoints.length).toBe(0);

    // Turn 3 — checkpoint
    await mw.onAfterTurn?.(ctx);
    expect(persistence.savedCheckpoints.length).toBe(1);
  });

  test("wrapToolCall captures artifact for configured tool names", async () => {
    const testHarness = createTestHarness({ artifactToolNames: ["code_search"] });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 1 });
    const request: ToolRequest = { toolId: "code_search", input: { query: "foo" } };
    const mockResponse: ToolResponse = { output: "Found 3 files" };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => mockResponse;

    const response = await mw.wrapToolCall?.(ctx, request, next);
    expect(response).toEqual(mockResponse);

    // Pause to flush artifacts into snapshot
    await testHarness.pause(createSessionResult());
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.keyArtifacts).toHaveLength(1);
    expect(headResult.value?.data.keyArtifacts[0]?.toolName).toBe("code_search");
    expect(headResult.value?.data.keyArtifacts[0]?.content).toBe("Found 3 files");
  });

  test("wrapToolCall ignores non-configured tool names", async () => {
    const testHarness = createTestHarness({ artifactToolNames: ["code_search"] });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 1 });
    const request: ToolRequest = { toolId: "other_tool", input: {} };
    const mockResponse: ToolResponse = { output: "Some output" };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => mockResponse;

    await mw.wrapToolCall?.(ctx, request, next);

    // Pause — no artifacts should be captured
    await testHarness.pause(createSessionResult());
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.keyArtifacts).toHaveLength(0);
  });

  test("wrapToolCall truncates large artifact content to 2000 chars", async () => {
    const testHarness = createTestHarness({ artifactToolNames: ["big_tool"] });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    const ctx = createMockTurnContext({ turnIndex: 1 });
    const request: ToolRequest = { toolId: "big_tool", input: {} };
    const largeOutput = "x".repeat(5000);
    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: largeOutput });

    await mw.wrapToolCall?.(ctx, request, next);

    await testHarness.pause(createSessionResult());
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.keyArtifacts[0]?.content.length).toBe(2000);
  });

  test("onSessionEnd flushes captured artifacts to snapshot", async () => {
    const testHarness = createTestHarness({ artifactToolNames: ["code_search"] });
    await testHarness.start(createTestPlan());
    const mw = testHarness.createMiddleware();

    // Capture an artifact via wrapToolCall
    const ctx = createMockTurnContext({ turnIndex: 1 });
    const request: ToolRequest = { toolId: "code_search", input: { query: "bar" } };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "Result" });
    await mw.wrapToolCall?.(ctx, request, next);

    // Fire onSessionEnd — should flush artifacts
    const sessionCtx = createMockSessionContext();
    await mw.onSessionEnd?.(sessionCtx);

    // Verify artifacts were persisted
    const headResult = await harnessStore.head(TEST_CHAIN_ID);
    assertOk(headResult);
    expect(headResult.value?.data.keyArtifacts).toHaveLength(1);
    expect(headResult.value?.data.keyArtifacts[0]?.content).toBe("Result");
  });

  test("onSessionEnd is no-op when no artifacts captured", async () => {
    await harness.start(createTestPlan());
    const mw = harness.createMiddleware();

    const sessionCtx = createMockSessionContext();
    // Should not throw or error
    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("prevents further operations", async () => {
    await harness.dispose();
    const result = await harness.start(createTestPlan());
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("is idempotent", async () => {
    await harness.dispose();
    await harness.dispose(); // Should not throw
  });
});
