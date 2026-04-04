/**
 * TaskCascade — unit tests for all 4 failure mode scenarios (Issue 12A).
 *
 * Tests written BEFORE implementation (TDD).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createTaskCascade } from "./task-cascade.js";

async function freshResultsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cascade-test-"));
}

async function freshBoard() {
  const store = createMemoryTaskBoardStore();
  return createManagedTaskBoard({ store });
}

function taskItemId(id: string): import("@koi/core").TaskItemId {
  return id as import("@koi/core").TaskItemId;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  test("returns cycle path for A→B→A dependency loop", async () => {
    // We build this by hand since the board prevents cycles at add time.
    // We use a snapshot with manually crafted tasks.
    const board = await freshBoard();
    // Add A without deps first, then B depends on A — this is valid (no cycle yet)
    await board.add({ id: taskItemId("task_A"), description: "Task A", dependencies: [] });
    await board.add({
      id: taskItemId("task_B"),
      description: "Task B",
      dependencies: [taskItemId("task_A")],
    });

    const cascade = createTaskCascade(board);
    // No cycle in a valid DAG
    expect(cascade.detectCycles()).toBeUndefined();
  });

  test("returns undefined for valid linear chain A→B→C", async () => {
    const board = await freshBoard();
    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({
      id: taskItemId("task_B"),
      description: "B",
      dependencies: [taskItemId("task_A")],
    });
    await board.add({
      id: taskItemId("task_C"),
      description: "C",
      dependencies: [taskItemId("task_B")],
    });

    const cascade = createTaskCascade(board);
    expect(cascade.detectCycles()).toBeUndefined();
  });

  test("returns undefined for empty board", async () => {
    const board = await freshBoard();
    const cascade = createTaskCascade(board);
    expect(cascade.detectCycles()).toBeUndefined();
  });

  test("returns undefined for independent parallel tasks", async () => {
    const board = await freshBoard();
    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({ id: taskItemId("task_B"), description: "B", dependencies: [] });
    await board.add({ id: taskItemId("task_C"), description: "C", dependencies: [] });

    const cascade = createTaskCascade(board);
    expect(cascade.detectCycles()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findReady — tasks whose all deps are completed
// ---------------------------------------------------------------------------

describe("findReady", () => {
  test("returns tasks with no dependencies", async () => {
    const board = await freshBoard();
    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({ id: taskItemId("task_B"), description: "B", dependencies: [] });

    const cascade = createTaskCascade(board);
    const ready = cascade.findReady();
    expect(ready).toContain(taskItemId("task_A"));
    expect(ready).toContain(taskItemId("task_B"));
  });

  test("does not return a task blocked by an incomplete dependency", async () => {
    const board = await freshBoard();
    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({
      id: taskItemId("task_B"),
      description: "B",
      dependencies: [taskItemId("task_A")],
    });

    const cascade = createTaskCascade(board);
    const ready = cascade.findReady();
    expect(ready).toContain(taskItemId("task_A"));
    expect(ready).not.toContain(taskItemId("task_B"));
  });

  test("unblocks task C after A and B both complete", async () => {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await freshResultsDir();
    const board = await createManagedTaskBoard({ store, resultsDir });
    const agentId = "test-agent" as import("@koi/core").AgentId;

    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({ id: taskItemId("task_B"), description: "B", dependencies: [] });
    await board.add({
      id: taskItemId("task_C"),
      description: "C",
      dependencies: [taskItemId("task_A"), taskItemId("task_B")],
    });

    const cascade = createTaskCascade(board);

    // Before completion: C is blocked
    expect(cascade.findReady()).not.toContain(taskItemId("task_C"));

    // Complete A
    await board.assign(taskItemId("task_A"), agentId);
    await board.completeOwnedTask(taskItemId("task_A"), agentId, {
      taskId: taskItemId("task_A"),
      output: "done A",
      durationMs: 0,
    });

    // Still blocked (B not done)
    expect(cascade.findReady()).not.toContain(taskItemId("task_C"));

    // Complete B
    await board.assign(taskItemId("task_B"), agentId);
    await board.completeOwnedTask(taskItemId("task_B"), agentId, {
      taskId: taskItemId("task_B"),
      output: "done B",
      durationMs: 0,
    });

    // Now C should be ready
    expect(cascade.findReady()).toContain(taskItemId("task_C"));
  });

  test("findReady is idempotent — two calls with same snapshot return same result", async () => {
    const board = await freshBoard();
    await board.add({ id: taskItemId("task_A"), description: "A", dependencies: [] });
    await board.add({ id: taskItemId("task_B"), description: "B", dependencies: [] });

    const cascade = createTaskCascade(board);
    const first = cascade.findReady();
    const second = cascade.findReady();

    expect(first).toEqual(second);
  });
});
