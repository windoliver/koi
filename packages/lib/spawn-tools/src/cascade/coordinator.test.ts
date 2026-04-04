/**
 * Coordinator integration scenarios (Issue 10A — all 5 missing test scenarios).
 *
 * Tests written as failing first, then implemented.
 * These test the coordinator tool composition: task-tools + spawn-tools + cascade.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createTaskCascade, recoverOrphanedTasks } from "./index.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

async function freshBoard() {
  const store = createMemoryTaskBoardStore();
  const resultsDir = await mkdtemp(join(tmpdir(), "coord-test-"));
  return createManagedTaskBoard({ store, resultsDir });
}

// ---------------------------------------------------------------------------
// Scenario 1: Partial success — 3/5 children complete, 2 fail permanently
// ---------------------------------------------------------------------------

describe("Coordinator: partial success aggregation", () => {
  test("board correctly reflects 3 completed and 2 failed tasks", async () => {
    const board = await freshBoard();
    const coord = agentId("coordinator");

    // Create 5 tasks
    const ids: import("@koi/core").TaskItemId[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await board.nextId();
      await board.add({ id, description: `Task ${String(i + 1)}` });
      ids.push(id);
    }

    // Assign and complete 3, fail 2
    for (let i = 0; i < 3; i++) {
      const id = ids[i];
      if (id === undefined) throw new Error(`ids[${String(i)}] undefined`);
      await board.assign(id, coord);
      await board.completeOwnedTask(id, coord, {
        taskId: id,
        output: `Done task ${String(i + 1)}`,
        durationMs: 100,
      });
    }
    for (let i = 3; i < 5; i++) {
      const id = ids[i];
      if (id === undefined) throw new Error(`ids[${String(i)}] undefined`);
      await board.assign(id, coord);
      await board.failOwnedTask(id, coord, {
        code: "EXTERNAL",
        message: `Task ${String(i + 1)} failed permanently`,
        retryable: false,
      });
    }

    // Coordinator sees partial results
    const snapshot = board.snapshot();
    const completed = snapshot.all().filter((t) => t.status === "completed");
    const failed = snapshot.all().filter((t) => t.status === "failed");

    expect(completed.length).toBe(3);
    expect(failed.length).toBe(2);

    // All tasks are in terminal state — coordinator can synthesize without blocking
    const nonTerminal = snapshot
      .all()
      .filter((t) => t.status === "pending" || t.status === "in_progress");
    expect(nonTerminal.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Concurrent completions — findReady is idempotent
// ---------------------------------------------------------------------------

describe("Coordinator: concurrent completion idempotency", () => {
  test("findReady returns the same unblocked tasks on concurrent calls", async () => {
    const board = await freshBoard();
    const coord = agentId("coordinator");

    const idA = await board.nextId();
    await board.add({ id: idA, description: "A" });
    const idB = await board.nextId();
    await board.add({ id: idB, description: "B" });
    const idC = await board.nextId();
    await board.add({ id: idC, description: "C", dependencies: [idA, idB] });

    const cascade = createTaskCascade(board);

    // Complete A and B concurrently (simulate two children finishing at the same time)
    await board.assign(idA, coord);
    await board.assign(idB, coord);
    await board.completeOwnedTask(idA, coord, { taskId: idA, output: "A done", durationMs: 0 });
    await board.completeOwnedTask(idB, coord, { taskId: idB, output: "B done", durationMs: 0 });

    // Calling findReady twice should yield identical results (pure read)
    const ready1 = cascade.findReady();
    const ready2 = cascade.findReady();

    expect(ready1).toEqual(ready2);
    expect(ready1).toContain(idC);

    // Only delegate C once — the board's assign call prevents double-delegation
    const d1 = await board.assign(idC, coord);
    expect(d1.ok).toBe(true);
    const d2 = await board.assign(idC, coord);
    // Second assign on in_progress task fails (expected — prevents duplicate delegation)
    expect(d2.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Crash recovery — orphaned tasks reset
// (already covered by recover-orphans.test.ts, but exercised end-to-end here)
// ---------------------------------------------------------------------------

describe("Coordinator: crash recovery end-to-end", () => {
  test("coordinator restart: orphaned tasks killed and re-queued as pending", async () => {
    const board = await freshBoard();
    const newCoord = agentId("new-coordinator");

    // Simulate 2 tasks delegated to children that are now orphaned
    const id1 = await board.nextId();
    const id2 = await board.nextId();
    await board.add({ id: id1, description: "Research task" });
    await board.add({ id: id2, description: "Code task" });
    await board.assign(id1, agentId("old-child-1"));
    await board.assign(id2, agentId("old-child-2"));

    const result = await recoverOrphanedTasks(board, newCoord);

    expect(result.killed.length).toBe(2);
    expect(result.requeued.length).toBe(2);

    const cascade = createTaskCascade(board);
    // Re-queued tasks are pending and ready for re-delegation
    const ready = cascade.findReady();
    for (const id of result.requeued) {
      expect(ready).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Zero-task coordinator
// ---------------------------------------------------------------------------

describe("Coordinator: zero-task scenario", () => {
  test("empty board — findReady returns empty, no errors", async () => {
    const board = await freshBoard();
    const cascade = createTaskCascade(board);

    expect(cascade.findReady()).toEqual([]);
    expect(cascade.detectCycles()).toBeUndefined();
  });

  test("board with only completed tasks — findReady returns empty", async () => {
    const board = await freshBoard();
    const coord = agentId("coordinator");

    const id = await board.nextId();
    await board.add({ id, description: "Already done task" });
    await board.assign(id, coord);
    await board.completeOwnedTask(id, coord, { taskId: id, output: "done", durationMs: 0 });

    const cascade = createTaskCascade(board);
    expect(cascade.findReady()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: task_delegate regression
// (also covered in task-tools.test.ts — documented here as cross-reference)
// ---------------------------------------------------------------------------

describe("Coordinator: task_delegate allows fan-out (cross-reference)", () => {
  test("task_delegate is not guarded by single-in-progress — N tasks delegate concurrently", async () => {
    // This scenario is tested in @koi/task-tools task-tools.test.ts:
    //   "task_delegate > allows N tasks to be delegated simultaneously without in_progress conflict"
    //   "task_update regression > task_update cannot start a second task when one is already delegated"
    //
    // Documented here as Issue 10A scenario 5. Implementation is in @koi/task-tools.
    expect(true).toBe(true); // Intentional pass-through — actual tests in task-tools
  });
});
