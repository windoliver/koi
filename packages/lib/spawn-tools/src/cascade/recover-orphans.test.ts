/**
 * recoverOrphanedTasks — unit tests (Issue 10A scenario 3: crash recovery).
 *
 * Uses board.unassign() for atomic in_progress → pending recovery.
 * No tasks are killed; task IDs are preserved; no data-loss or duplicate windows.
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
  test("unassigns orphaned in_progress tasks and re-queues them as pending (same IDs)", async () => {
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

    // killed is always empty (unassign does not kill tasks)
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(3);
    expect(result.failed.length).toBe(0);

    // Recovered tasks preserve their original IDs and are now pending
    const snapshot = board.snapshot();
    for (const id of result.requeued) {
      expect(snapshot.get(id)?.status).toBe("pending");
    }

    // Same IDs — task IDs are preserved by unassign()
    const requeuedSet = new Set<TaskItemId>(result.requeued);
    expect(requeuedSet.has(id1)).toBe(true);
    expect(requeuedSet.has(id2)).toBe(true);
    expect(requeuedSet.has(id3)).toBe(true);
  });

  test("does not unassign tasks assigned to the current coordinator", async () => {
    const board = await freshBoard();
    const coordAgent = agentId("coordinator");

    const id1 = await addTask(board, "Coord's task");
    await board.assign(id1, coordAgent);

    const result = await recoverOrphanedTasks(board, coordAgent);

    // id1 belongs to coordAgent — not orphaned
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(0);

    expect(board.snapshot().get(id1)?.status).toBe("in_progress");
  });

  test("returns empty result when board has no in_progress tasks", async () => {
    const board = await freshBoard();
    await addTask(board, "Pending task");

    const result = await recoverOrphanedTasks(board, agentId("coordinator"));
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(0);
  });

  test("result always includes a failed field (empty on full success)", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    await board.assign(id1, agentId("child-1"));

    const result = await recoverOrphanedTasks(board, newAgent);

    expect(result.failed).toBeDefined();
    expect(result.failed.length).toBe(0);
    expect(result.requeued.length).toBe(1);
    expect(result.requeued[0]).toBe(id1);
  });

  test("preserves subject and description in re-queued tasks", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Investigate OAuth2 integration patterns", "Research OAuth2");
    await board.assign(id1, agentId("child-1"));

    const result = await recoverOrphanedTasks(board, newAgent);
    expect(result.requeued.length).toBe(1);

    // Same ID — task preserved in place by unassign()
    const recoveredId = result.requeued[0];
    if (recoveredId === undefined) throw new Error("Expected a requeued task");
    expect(recoveredId).toBe(id1);
    const task = board.snapshot().get(id1);
    expect(task?.subject).toBe("Research OAuth2");
    expect(task?.description).toBe("Investigate OAuth2 integration patterns");
    expect(task?.status).toBe("pending");
    expect(task?.assignedTo).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Partial failure cases
  // ---------------------------------------------------------------------------

  test("reports failed IDs when unassign fails — original task left in_progress (no data loss)", async () => {
    const realBoard = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(realBoard, "Task 1");
    await realBoard.assign(id1, agentId("child-1"));

    // Wrap the real board with a proxy that makes unassign() always fail
    const failingBoard: ManagedTaskBoard = {
      ...realBoard,
      unassign: async () => ({
        ok: false as const,
        error: {
          code: "INTERNAL" as const,
          message: "simulated unassign failure",
          retryable: false,
        },
      }),
    };

    const result = await recoverOrphanedTasks(failingBoard, newAgent);

    // unassign() failed — original task remains in_progress (no data loss, no kill)
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toBe(id1);
    expect(realBoard.snapshot().get(id1)?.status).toBe("in_progress");
  });

  test("skips tasks assigned to coordinator even when other orphans exist", async () => {
    const board = await freshBoard();
    const coordAgent = agentId("coordinator");

    const id1 = await addTask(board, "Orphan task");
    const id2 = await addTask(board, "Coordinator's task");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, coordAgent);

    // coordAgent is the current coordinator — id2 is its own task, not an orphan
    const result = await recoverOrphanedTasks(board, coordAgent);

    // id2 belongs to coordAgent (the current coordinator) — not orphaned
    // id1 is orphaned (belongs to child-1)
    expect(result.requeued.length).toBe(1);
    expect(result.requeued[0]).toBe(id1);
    expect(board.snapshot().get(id2)?.status).toBe("in_progress"); // coord's task untouched
  });

  test("processes all orphans sequentially: all recovered when board healthy", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    const id2 = await addTask(board, "Task 2");
    const id3 = await addTask(board, "Task 3");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, agentId("child-2"));
    await board.assign(id3, agentId("child-3"));

    const result = await recoverOrphanedTasks(board, newAgent);

    // All 3 should be unassigned and requeued with no failures
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(3);
    expect(result.failed.length).toBe(0);

    // Requeued IDs are the original IDs (preserved by unassign)
    const requeuedSet = new Set<TaskItemId>(result.requeued);
    expect(requeuedSet.has(id1)).toBe(true);
    expect(requeuedSet.has(id2)).toBe(true);
    expect(requeuedSet.has(id3)).toBe(true);
  });
});
