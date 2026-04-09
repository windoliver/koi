/**
 * recoverOrphanedTasks — unit tests (Issue 10A scenario 3: crash recovery).
 *
 * Uses board.unassign() for atomic in_progress → pending recovery.
 * No tasks are killed; task IDs are preserved; no data-loss or duplicate windows.
 *
 * Error handling: per-task races (NOT_FOUND, VALIDATION, CONFLICT) are skipped;
 * store-layer errors (EXTERNAL, INTERNAL) stop the recovery pass.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedTaskBoard, TaskItemId } from "@koi/core";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { recoverOrphanedTasks, recoverStaleDelegations } from "./recover-orphans.js";

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
  // Per-task race cases — skip, do not abort
  // ---------------------------------------------------------------------------

  test("skips orphan that completed during recovery (VALIDATION race is non-fatal)", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1"); // will be recovered
    const id2 = await addTask(board, "Task 2"); // will complete mid-recovery
    const id3 = await addTask(board, "Task 3"); // will be recovered

    const childCoord = agentId("child-coord");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, agentId("child-2"));
    await board.assign(id3, agentId("child-3"));

    // Simulate: id2 completes just before its unassign() runs (VALIDATION race)
    // Use a proxy that fails unassign for id2 with VALIDATION (task not in_progress)
    const failOnId2: ManagedTaskBoard = {
      ...board,
      unassign: async (taskId) => {
        if (taskId === id2) {
          return {
            ok: false as const,
            error: {
              code: "VALIDATION" as const,
              message: "task is completed, not in_progress",
              retryable: false,
            },
          };
        }
        return board.unassign(taskId);
      },
    };

    const result = await recoverOrphanedTasks(failOnId2, newAgent);

    // id2 skipped (VALIDATION race), id1 and id3 recovered
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(2); // id1 + id3
    expect(result.failed.length).toBe(0); // VALIDATION is not a store failure

    const requeuedSet = new Set<TaskItemId>(result.requeued);
    expect(requeuedSet.has(id1)).toBe(true);
    expect(requeuedSet.has(id2)).toBe(false); // skipped, not failed
    expect(requeuedSet.has(id3)).toBe(true);

    // id2 was not touched (proxy blocked unassign) — still in_progress
    expect(board.snapshot().get(id2)?.status).toBe("in_progress");

    void childCoord; // suppress unused warning
  });

  test("stops on store-layer error (EXTERNAL) and reports failed ID", async () => {
    const realBoard = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(realBoard, "Task 1");
    await realBoard.assign(id1, agentId("child-1"));

    // Wrap the real board with a proxy that makes unassign() fail with EXTERNAL
    const failingBoard: ManagedTaskBoard = {
      ...realBoard,
      unassign: async () => ({
        ok: false as const,
        error: {
          code: "EXTERNAL" as const,
          message: "simulated store failure",
          retryable: true,
        },
      }),
    };

    const result = await recoverOrphanedTasks(failingBoard, newAgent);

    // Store-layer error — stop processing, report as failed
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toBe(id1);
    // Original task left in_progress (failingBoard proxy, realBoard unchanged)
    expect(realBoard.snapshot().get(id1)?.status).toBe("in_progress");
  });

  test("stops on CONFLICT (store version conflict) — not a benign per-task race", async () => {
    const board = await freshBoard();
    const newAgent = agentId("new-coordinator");

    const id1 = await addTask(board, "Task 1");
    const id2 = await addTask(board, "Task 2");
    const id3 = await addTask(board, "Task 3");
    await board.assign(id1, agentId("child-1"));
    await board.assign(id2, agentId("child-2"));
    await board.assign(id3, agentId("child-3"));

    // id2 has a CONFLICT (store version conflict) — should STOP recovery, not skip
    const conflictOnId2: ManagedTaskBoard = {
      ...board,
      unassign: async (taskId) => {
        if (taskId === id2) {
          return {
            ok: false as const,
            error: {
              code: "CONFLICT" as const,
              message: "version conflict — possible concurrent write",
              retryable: true,
            },
          };
        }
        return board.unassign(taskId);
      },
    };

    const result = await recoverOrphanedTasks(conflictOnId2, newAgent);

    // id1 recovered, id2 stopped recovery (CONFLICT is a store error), id3 not reached
    expect(result.killed.length).toBe(0);
    expect(result.requeued.length).toBe(1); // only id1 (processed before id2)
    expect(result.failed.length).toBe(1); // id2 reported as failed
    expect(result.failed[0]).toBe(id2);

    // id3 was not processed (recovery stopped at id2)
    const requeuedSet = new Set<TaskItemId>(result.requeued);
    expect(requeuedSet.has(id1)).toBe(true);
    expect(requeuedSet.has(id3)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Other edge cases
  // ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// recoverStaleDelegations (#1557 review fix 4A revised)
// ---------------------------------------------------------------------------
//
// The `task_delegate` tool in @koi/task-tools records a coordinator's intent
// to assign a pending task to a child agent via metadata.delegatedTo, but
// leaves task.assignedTo untouched. If the child crashes before claiming,
// the task sits with a stale delegatedTo that blocks re-delegation. This
// function handles that cleanup on restart, complementing
// recoverOrphanedTasks (which handles in_progress orphans).

describe("recoverStaleDelegations", () => {
  /**
   * Add a pending task and set metadata.delegatedTo without changing status.
   * Mirrors what task_delegate does in production.
   */
  async function addDelegatedTask(
    board: ManagedTaskBoard,
    description: string,
    delegatedTo: string,
  ): Promise<TaskItemId> {
    const id = await board.nextId();
    await board.add({ id, description, metadata: { delegatedTo } });
    return id;
  }

  test("clears delegatedTo when the intended worker is not in the live set", async () => {
    const board = await freshBoard();
    const id1 = await addDelegatedTask(board, "Task 1", "dead-worker");
    const id2 = await addDelegatedTask(board, "Task 2", "another-dead-worker");

    const result = await recoverStaleDelegations(board, new Set<string>());
    expect(result.failed).toHaveLength(0);
    expect(result.cleared).toHaveLength(2);

    const cleared = new Set<TaskItemId>(result.cleared);
    expect(cleared.has(id1)).toBe(true);
    expect(cleared.has(id2)).toBe(true);

    // Task is still pending and delegatedTo is gone
    const snap = board.snapshot();
    const t1 = snap.get(id1);
    expect(t1?.status).toBe("pending");
    expect(t1?.metadata?.delegatedTo).toBeUndefined();
  });

  test("preserves delegation for workers still in the live set", async () => {
    const board = await freshBoard();
    const idLive = await addDelegatedTask(board, "Live task", "live-worker");
    const idDead = await addDelegatedTask(board, "Dead task", "dead-worker");

    const result = await recoverStaleDelegations(board, new Set<string>(["live-worker"]));
    expect(result.cleared).toHaveLength(1);
    expect(result.cleared[0]).toBe(idDead);

    // Live delegation preserved
    expect(board.snapshot().get(idLive)?.metadata?.delegatedTo).toBe("live-worker");
    // Dead delegation cleared
    expect(board.snapshot().get(idDead)?.metadata?.delegatedTo).toBeUndefined();
  });

  test("leaves non-pending tasks alone even if they have a delegatedTo", async () => {
    const board = await freshBoard();
    const pendingId = await addDelegatedTask(board, "Pending", "dead-worker");
    const inProgressId = await addDelegatedTask(board, "In progress", "dead-worker");
    // Start the second one so it becomes in_progress
    await board.assign(inProgressId, agentId("some-agent"));

    const result = await recoverStaleDelegations(board, new Set<string>());
    // Only the pending task is cleared
    expect(result.cleared).toEqual([pendingId]);
    // In-progress task still has its metadata — this function doesn't touch it
    expect(board.snapshot().get(inProgressId)?.metadata?.delegatedTo).toBe("dead-worker");
  });

  test("preserves other metadata keys when clearing delegatedTo", async () => {
    const board = await freshBoard();
    const id = await board.nextId();
    await board.add({
      id,
      description: "Task with rich metadata",
      metadata: { delegatedTo: "dead-worker", kind: "research", priority: 5 },
    });

    const result = await recoverStaleDelegations(board, new Set<string>());
    expect(result.cleared).toEqual([id]);
    const task = board.snapshot().get(id);
    expect(task?.metadata?.delegatedTo).toBeUndefined();
    expect(task?.metadata?.kind).toBe("research");
    expect(task?.metadata?.priority).toBe(5);
  });

  test("returns empty result when no pending tasks have a delegation", async () => {
    const board = await freshBoard();
    await addTask(board, "Plain pending task");
    const result = await recoverStaleDelegations(board, new Set<string>());
    expect(result.cleared).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("skips malformed delegatedTo (not a string)", async () => {
    const board = await freshBoard();
    const id = await board.nextId();
    // Plant a non-string delegatedTo via the board (test-only edge case)
    await board.add({
      id,
      description: "Malformed",
      metadata: { delegatedTo: 42 as unknown as string },
    });
    const result = await recoverStaleDelegations(board, new Set<string>());
    // Malformed values are treated as "no delegation" → skipped
    expect(result.cleared).toEqual([]);
  });

  test("stops on store-layer error and reports failed ID", async () => {
    const realBoard = await freshBoard();
    const id1 = await addDelegatedTask(realBoard, "Task 1", "dead");
    const id2 = await addDelegatedTask(realBoard, "Task 2", "dead");

    // Wrap update() with a proxy that rejects with EXTERNAL (simulated store outage)
    const failingBoard: ManagedTaskBoard = {
      ...realBoard,
      update: async () => ({
        ok: false as const,
        error: {
          code: "EXTERNAL" as const,
          message: "store I/O",
          retryable: true,
        },
      }),
    };

    const result = await recoverStaleDelegations(failingBoard, new Set<string>());
    // Processing stops at the first store error
    expect(result.cleared).toEqual([]);
    expect(result.failed).toHaveLength(1);
    // The real board state is unchanged (the proxy only intercepted update)
    expect(realBoard.snapshot().get(id1)?.metadata?.delegatedTo).toBe("dead");
    expect(realBoard.snapshot().get(id2)?.metadata?.delegatedTo).toBe("dead");
  });

  test("skips per-task races (VALIDATION) and keeps processing", async () => {
    const realBoard = await freshBoard();
    const id1 = await addDelegatedTask(realBoard, "Task 1", "dead");
    const id2 = await addDelegatedTask(realBoard, "Task 2", "dead");
    const id3 = await addDelegatedTask(realBoard, "Task 3", "dead");

    // Fail id2 with VALIDATION (simulates "task completed mid-recovery").
    // id1 and id3 should still be cleared on the real board.
    const skippingBoard: ManagedTaskBoard = {
      ...realBoard,
      update: async (taskId, patch) => {
        if (taskId === id2) {
          return {
            ok: false as const,
            error: {
              code: "VALIDATION" as const,
              message: "task no longer pending",
              retryable: false,
            },
          };
        }
        return realBoard.update(taskId, patch);
      },
    };

    const result = await recoverStaleDelegations(skippingBoard, new Set<string>());
    // id1 and id3 cleared, id2 skipped (not in cleared OR failed)
    expect(result.failed).toHaveLength(0);
    const cleared = new Set<TaskItemId>(result.cleared);
    expect(cleared.has(id1)).toBe(true);
    expect(cleared.has(id2)).toBe(false);
    expect(cleared.has(id3)).toBe(true);
  });

  test("cooperates with recoverOrphanedTasks — pending and in_progress both recover", async () => {
    // Scenario: coordinator crashes. On restart:
    //  - tasks A, B are in_progress assigned to dead children → orphan recovery
    //  - tasks C, D are pending with delegatedTo=dead → stale delegation cleanup
    // Both functions run to completion without interfering.
    const board = await freshBoard();
    const idA = await addTask(board, "In-progress A");
    const idB = await addTask(board, "In-progress B");
    const idC = await addDelegatedTask(board, "Pending C", "dead-delegated-1");
    const idD = await addDelegatedTask(board, "Pending D", "dead-delegated-2");

    await board.assign(idA, agentId("dead-child-a"));
    await board.assign(idB, agentId("dead-child-b"));

    const newCoord = agentId("new-coord");
    const orphanResult = await recoverOrphanedTasks(board, newCoord);
    const staleResult = await recoverStaleDelegations(board, new Set<string>());

    // Orphan recovery: both in_progress tasks → pending, same IDs
    expect(orphanResult.requeued).toHaveLength(2);
    expect(board.snapshot().get(idA)?.status).toBe("pending");
    expect(board.snapshot().get(idB)?.status).toBe("pending");
    // Stale delegation cleanup: both delegated-pending tasks cleared
    expect(staleResult.cleared).toHaveLength(2);
    expect(board.snapshot().get(idC)?.metadata?.delegatedTo).toBeUndefined();
    expect(board.snapshot().get(idD)?.metadata?.delegatedTo).toBeUndefined();
  });
});
