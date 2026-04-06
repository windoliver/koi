/**
 * recoverOrphanedTasks — unit tests (Issue 10A scenario 3: crash recovery).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedTaskBoard, TaskItemId } from "@koi/core";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { recoverOrphanedTasks } from "./recover-orphans.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

async function freshBoard() {
  const store = createMemoryTaskBoardStore();
  const resultsDir = await mkdtemp(join(tmpdir(), "recover-test-"));
  return createManagedTaskBoard({ store, resultsDir });
}

/** Add a task using board.nextId() (like task_create does in production). */
async function addTask(
  board: ManagedTaskBoard,
  description: string,
  subject?: string,
): Promise<import("@koi/core").TaskItemId> {
  const id = await board.nextId();
  await board.add({ id, description, ...(subject !== undefined ? { subject } : {}) });
  return id;
}

describe("recoverOrphanedTasks", () => {
  test("kills orphaned in_progress tasks and re-queues them as pending", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    // Simulate 3 tasks delegated to children during the previous session
    const id1 = await addTask(board, "Task 1");
    const id2 = await addTask(board, "Task 2");
    const id3 = await addTask(board, "Task 3");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, agentId("child-2"));
    await board.assign(id3, agentId("child-3"));

    // Coordinator crashes — newAgent restarts and finds orphaned tasks
    const result = await recoverOrphanedTasks(board, newAgent);

    expect(result.killed.length).toBe(3);
    expect(result.requeued.length).toBe(3);

    // Orphaned tasks are now killed (terminal)
    const snapshot = board.snapshot();
    for (const id of result.killed) {
      expect(snapshot.get(id)?.status).toBe("killed");
    }

    // Replacement tasks are pending
    for (const id of result.requeued) {
      expect(snapshot.get(id)?.status).toBe("pending");
    }
  });

  test("does not kill tasks assigned to the current coordinator", async () => {
    const board = await freshBoard();
    const coordAgent = agentId("coordinator");

    const id1 = await addTask(board, "Coord's task");
    await board.assign(id1, coordAgent);

    const result = await recoverOrphanedTasks(board, coordAgent);

    // id1 belongs to coordAgent — not orphaned
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);

    expect(board.snapshot().get(id1)?.status).toBe("in_progress");
  });

  test("returns empty result when board has no in_progress tasks", async () => {
    const board = await freshBoard();
    await addTask(board, "Pending task");

    const result = await recoverOrphanedTasks(board, agentId("coordinator"));
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
  });

  test("result always includes a failed field (empty on full success)", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    await board.assign(id1, agentId("child-1"));

    const result = await recoverOrphanedTasks(board, newAgent);

    expect(result.failed).toBeDefined();
    expect(result.failed.length).toBe(0);
  });

  test("preserves subject and description in re-queued tasks", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Investigate OAuth2 integration patterns", "Research OAuth2");
    await board.assign(id1, agentId("child-1"));

    const result = await recoverOrphanedTasks(board, newAgent);
    expect(result.requeued.length).toBe(1);

    const newTaskId = result.requeued[0];
    if (newTaskId === undefined) throw new Error("Expected a requeued task");
    const newTask = board.snapshot().get(newTaskId);
    expect(newTask?.subject).toBe("Research OAuth2");
    expect(newTask?.description).toBe("Investigate OAuth2 integration patterns");
  });

  // ---------------------------------------------------------------------------
  // Partial failure cases (Decision 7-A / 12-A)
  // ---------------------------------------------------------------------------

  test("reports failed IDs when kill succeeds but add fails (partial data loss)", async () => {
    const realBoard = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(realBoard, "Task 1");
    await realBoard.assign(id1, agentId("child-1"));

    // Wrap the real board with a proxy that makes add() always fail
    const failingBoard: ManagedTaskBoard = {
      ...realBoard,
      add: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "simulated add failure", retryable: false },
      }),
    };

    const result = await recoverOrphanedTasks(failingBoard, newAgent);

    // Task was killed but could not be requeued
    expect(result.killed.length).toBe(1);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toBe(id1);
  });

  test("skips already-terminal tasks (kill fails) without adding to failed", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    await board.assign(id1, agentId("child-1"));
    // Pre-kill the task so it is already terminal when recovery runs
    await board.kill(id1);

    const result = await recoverOrphanedTasks(board, newAgent);

    // Task was already terminal — kill fails silently, not added to failed
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(0);
  });

  test("parallelises correctly with mixed kill results: some fail, some succeed", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    const id2 = await addTask(board, "Task 2");
    const id3 = await addTask(board, "Task 3");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, agentId("child-2"));
    await board.assign(id3, agentId("child-3"));

    const result = await recoverOrphanedTasks(board, newAgent);

    // All 3 should be killed and requeued with no failures
    expect(result.killed.length).toBe(3);
    expect(result.requeued.length).toBe(3);
    expect(result.failed.length).toBe(0);

    // Killed IDs are the original IDs
    const killedSet = new Set<TaskItemId>(result.killed);
    expect(killedSet.has(id1)).toBe(true);
    expect(killedSet.has(id2)).toBe(true);
    expect(killedSet.has(id3)).toBe(true);
  });
});
