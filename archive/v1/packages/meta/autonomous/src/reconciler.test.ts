/**
 * Tests for the task board reconciler — defense-in-depth consistency check.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentId,
  KoiError,
  Result,
  TaskBoard,
  TaskBoardSnapshot,
  TaskItemId,
} from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { createTaskBoard } from "@koi/task-board";
import type { ReconcileHarness } from "./reconciler.js";
import { reconcileTaskBoard } from "./reconciler.js";
import type { AutonomousLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKER_ID = agentId("worker-1");
const TASK_A = taskItemId("task-a");
const TASK_B = taskItemId("task-b");

function makeError(message: string): KoiError {
  return { code: "INTERNAL", message, retryable: false };
}

/**
 * Build a bridge TaskBoard with items in the specified states.
 * Drives items through the proper state machine transitions.
 */
function buildBridgeBoard(
  specs: readonly {
    readonly id: TaskItemId;
    readonly status: "pending" | "assigned" | "completed" | "failed";
    readonly output?: string;
    readonly error?: KoiError;
  }[],
): TaskBoard {
  let board: TaskBoard = createTaskBoard();

  for (const spec of specs) {
    const addResult = board.add({ id: spec.id, description: `Task ${spec.id}` });
    if (!addResult.ok) throw new Error(`Failed to add ${spec.id}: ${addResult.error.message}`);
    board = addResult.value;

    if (spec.status === "pending") continue;

    // Assign
    const assignResult = board.assign(spec.id, WORKER_ID);
    if (!assignResult.ok)
      throw new Error(`Failed to assign ${spec.id}: ${assignResult.error.message}`);
    board = assignResult.value;

    if (spec.status === "assigned") continue;

    if (spec.status === "completed") {
      const completeResult = board.complete(spec.id, {
        taskId: spec.id,
        output: spec.output ?? "done",
        durationMs: 100,
      });
      if (!completeResult.ok)
        throw new Error(`Failed to complete ${spec.id}: ${completeResult.error.message}`);
      board = completeResult.value;
    } else if (spec.status === "failed") {
      const error = spec.error ?? makeError("bridge failure");
      const failResult = board.fail(spec.id, error);
      if (!failResult.ok) throw new Error(`Failed to fail ${spec.id}: ${failResult.error.message}`);
      board = failResult.value;
    }
  }

  return board;
}

/**
 * Build a harness snapshot with items at fixed states.
 * Harness snapshots are plain data — no state machine enforcement needed.
 */
function buildHarnessSnapshot(
  specs: readonly {
    readonly id: TaskItemId;
    readonly status: "pending" | "assigned" | "completed" | "failed";
    readonly assignedTo?: AgentId;
    readonly error?: KoiError;
  }[],
): TaskBoardSnapshot {
  return {
    items: specs.map((spec) => ({
      id: spec.id,
      description: `Task ${spec.id}`,
      dependencies: [],
      priority: 0,
      maxRetries: 3,
      retries: 0,
      status: spec.status,
      assignedTo: spec.assignedTo,
      error: spec.error,
    })),
    results: [],
  };
}

function okResult(): Result<void, KoiError> {
  return { ok: true, value: undefined };
}

function failResult(message: string): Result<void, KoiError> {
  return { ok: false, error: makeError(message) };
}

interface MockHarness extends ReconcileHarness {
  readonly assignTask: ReturnType<typeof mock>;
  readonly completeTask: ReturnType<typeof mock>;
  readonly failTask: ReturnType<typeof mock>;
}

function createMockHarness(harnessSnapshot: TaskBoardSnapshot): MockHarness {
  return {
    assignTask: mock(() => Promise.resolve(okResult())),
    completeTask: mock(() => Promise.resolve(okResult())),
    failTask: mock(() => Promise.resolve(okResult())),
    status: () => ({ taskBoard: harnessSnapshot }),
  };
}

function createMockLogger(): AutonomousLogger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warn: mock((msg: string) => {
      warnings.push(msg);
    }),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileTaskBoard", () => {
  test("happy path: no drift — returns fixed: 0 with empty details", async () => {
    const bridgeBoard = buildBridgeBoard([{ id: TASK_A, status: "completed", output: "result-a" }]);

    const harnessSnapshot = buildHarnessSnapshot([
      { id: TASK_A, status: "completed", assignedTo: WORKER_ID },
    ]);

    const harness = createMockHarness(harnessSnapshot);
    const result = await reconcileTaskBoard(bridgeBoard, harness);

    expect(result.fixed).toBe(0);
    expect(result.details).toEqual([]);
    expect(harness.assignTask).not.toHaveBeenCalled();
    expect(harness.completeTask).not.toHaveBeenCalled();
    expect(harness.failTask).not.toHaveBeenCalled();
  });

  test("task completed in bridge but assigned in harness — calls completeTask", async () => {
    const bridgeBoard = buildBridgeBoard([{ id: TASK_A, status: "completed", output: "result-a" }]);

    const harnessSnapshot = buildHarnessSnapshot([
      { id: TASK_A, status: "assigned", assignedTo: WORKER_ID },
    ]);

    const harness = createMockHarness(harnessSnapshot);
    const result = await reconcileTaskBoard(bridgeBoard, harness);

    expect(result.fixed).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain("completed");
    // Should NOT call assignTask — already assigned
    expect(harness.assignTask).not.toHaveBeenCalled();
    expect(harness.completeTask).toHaveBeenCalledTimes(1);
  });

  test("task completed in bridge but pending in harness — calls assignTask then completeTask", async () => {
    const bridgeBoard = buildBridgeBoard([{ id: TASK_A, status: "completed", output: "result-a" }]);

    const harnessSnapshot = buildHarnessSnapshot([{ id: TASK_A, status: "pending" }]);

    const harness = createMockHarness(harnessSnapshot);
    const result = await reconcileTaskBoard(bridgeBoard, harness);

    expect(result.fixed).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain("completed");
    // Must assign before completing
    expect(harness.assignTask).toHaveBeenCalledTimes(1);
    expect(harness.completeTask).toHaveBeenCalledTimes(1);
  });

  test("task failed in bridge but assigned in harness — calls failTask", async () => {
    const bridgeError = makeError("worker crashed");
    const bridgeBoard = buildBridgeBoard([{ id: TASK_A, status: "failed", error: bridgeError }]);

    const harnessSnapshot = buildHarnessSnapshot([
      { id: TASK_A, status: "assigned", assignedTo: WORKER_ID },
    ]);

    const harness = createMockHarness(harnessSnapshot);
    const result = await reconcileTaskBoard(bridgeBoard, harness);

    expect(result.fixed).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain("failed");
    // Should NOT call assignTask — already assigned
    expect(harness.assignTask).not.toHaveBeenCalled();
    expect(harness.failTask).toHaveBeenCalledTimes(1);
  });

  test("partial completion — only drifted task is fixed", async () => {
    const bridgeBoard = buildBridgeBoard([
      { id: TASK_A, status: "completed", output: "result-a" },
      { id: TASK_B, status: "completed", output: "result-b" },
    ]);

    const harnessSnapshot = buildHarnessSnapshot([
      // TASK_A: drifted — completed in bridge but assigned in harness
      { id: TASK_A, status: "assigned", assignedTo: WORKER_ID },
      // TASK_B: already in sync
      { id: TASK_B, status: "completed", assignedTo: WORKER_ID },
    ]);

    const harness = createMockHarness(harnessSnapshot);
    const result = await reconcileTaskBoard(bridgeBoard, harness);

    expect(result.fixed).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain(TASK_A);
    expect(harness.completeTask).toHaveBeenCalledTimes(1);
  });

  test("assignTask fails during reconciliation — skips task and returns fixed: 0", async () => {
    const bridgeBoard = buildBridgeBoard([{ id: TASK_A, status: "completed", output: "result-a" }]);

    // Pending in harness — reconciler must assign before completing
    const harnessSnapshot = buildHarnessSnapshot([{ id: TASK_A, status: "pending" }]);

    const harness = createMockHarness(harnessSnapshot);
    // Override assignTask to return failure
    harness.assignTask.mockImplementation(() => Promise.resolve(failResult("assign denied")));

    const logger = createMockLogger();
    const result = await reconcileTaskBoard(bridgeBoard, harness, logger);

    expect(result.fixed).toBe(0);
    expect(result.details).toEqual([]);
    // assignTask was called but failed
    expect(harness.assignTask).toHaveBeenCalledTimes(1);
    // completeTask should NOT be called because assign failed
    expect(harness.completeTask).not.toHaveBeenCalled();
    // Logger should have warned about the failure
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]).toContain("cannot assign");
  });
});
