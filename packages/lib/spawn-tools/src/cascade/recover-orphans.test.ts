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

  test("clears delegatedTo on in_progress tasks too (order-independence)", async () => {
    // Regression for Codex review finding (round 1): `assign()` preserves
    // `metadata.delegatedTo` when moving pending → in_progress. A pending-only
    // scan would miss in_progress tasks whose delegation marker is still set,
    // making this helper order-dependent with recoverOrphanedTasks. Scanning
    // every non-terminal task fixes the ordering hazard.
    const board = await freshBoard();
    const pendingId = await addDelegatedTask(board, "Pending", "dead-worker");
    const inProgressId = await addDelegatedTask(board, "In progress", "dead-worker");
    // Start the second one so it becomes in_progress (preserves metadata.delegatedTo)
    await board.assign(inProgressId, agentId("some-agent"));
    expect(board.snapshot().get(inProgressId)?.metadata?.delegatedTo).toBe("dead-worker");

    const result = await recoverStaleDelegations(board, new Set<string>());
    expect(result.failed).toHaveLength(0);
    expect(result.cleared).toHaveLength(2);
    const clearedSet = new Set<TaskItemId>(result.cleared);
    expect(clearedSet.has(pendingId)).toBe(true);
    expect(clearedSet.has(inProgressId)).toBe(true);
    // Both tasks' delegatedTo is cleared; in_progress task keeps its status
    expect(board.snapshot().get(pendingId)?.metadata?.delegatedTo).toBeUndefined();
    expect(board.snapshot().get(inProgressId)?.metadata?.delegatedTo).toBeUndefined();
    expect(board.snapshot().get(inProgressId)?.status).toBe("in_progress");
  });

  test("leaves terminal tasks alone even with a delegatedTo marker", async () => {
    // update() rejects terminal tasks. We must not attempt to mutate them.
    const board = await freshBoard();
    const id = await addDelegatedTask(board, "Will be killed", "dead-worker");
    // Kill while still pending
    await board.kill(id);
    expect(board.snapshot().get(id)?.status).toBe("killed");

    const result = await recoverStaleDelegations(board, new Set<string>());
    // Killed tasks are skipped — no cleared, no failed
    expect(result.cleared).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    // Metadata is untouched (delegatedTo still set, but terminal so harmless)
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("dead-worker");
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

  test("clears malformed delegatedTo values that would still block task_delegate", async () => {
    // Regression for Codex review finding (round 1): task_delegate rejects any
    // task where `metadata.delegatedTo !== undefined`, regardless of type. If
    // a legacy / corrupted store has `delegatedTo: 42` or `delegatedTo: null`,
    // a recovery pass that treats those as "no delegation" would report
    // success while leaving the task permanently undelegatable.
    const board = await freshBoard();
    const numberId = await board.nextId();
    const nullId = await board.nextId();
    const emptyStringId = await board.nextId();
    await board.add({
      id: numberId,
      description: "Number marker",
      metadata: { delegatedTo: 42 as unknown as string },
    });
    await board.add({
      id: nullId,
      description: "Null marker",
      metadata: { delegatedTo: null as unknown as string },
    });
    await board.add({
      id: emptyStringId,
      description: "Empty string marker",
      metadata: { delegatedTo: "" },
    });

    const result = await recoverStaleDelegations(board, new Set<string>());
    // All three malformed markers are cleared — task_delegate would otherwise
    // reject these tasks as "already delegated" regardless of the value's type.
    expect(result.failed).toHaveLength(0);
    expect(result.cleared).toHaveLength(3);
    const clearedSet = new Set<TaskItemId>(result.cleared);
    expect(clearedSet.has(numberId)).toBe(true);
    expect(clearedSet.has(nullId)).toBe(true);
    expect(clearedSet.has(emptyStringId)).toBe(true);
    // And all three now have no delegatedTo key at all
    for (const id of [numberId, nullId, emptyStringId]) {
      const metadata = board.snapshot().get(id)?.metadata;
      expect(metadata !== undefined && "delegatedTo" in metadata).toBe(false);
    }
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

  // ---------------------------------------------------------------------------
  // Real-flow regression for Codex review finding (round 1)
  // ---------------------------------------------------------------------------
  //
  // The bug: task_delegate → task_update(in_progress) preserves
  // metadata.delegatedTo on the in_progress task. If recoverStaleDelegations
  // scanned only pending() tasks and ran BEFORE recoverOrphanedTasks, the
  // in_progress delegation marker would survive unassign() and leave the
  // task permanently undelegatable. The fix scans all non-terminal tasks so
  // order doesn't matter.

  test("real flow (delegate → in_progress → recovery) — task is re-delegatable regardless of order", async () => {
    // "Real flow" means we exercise the same calls that task_delegate + task_update
    // would make: board.update with metadata.delegatedTo, then board.assign.
    const board = await freshBoard();
    const id = await board.nextId();
    await board.add({ id, description: "Work to be dispatched" });

    // Step 1: task_delegate records intent
    await board.update(id, { metadata: { delegatedTo: "child-worker" } });
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("child-worker");

    // Step 2: child claims the task via task_update(in_progress) — under the
    // hood this is board.assign. metadata.delegatedTo is NOT cleared by assign.
    await board.assign(id, agentId("child-worker"));
    expect(board.snapshot().get(id)?.status).toBe("in_progress");
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("child-worker");

    // Step 3: coordinator crashes. New coordinator restarts and runs recovery
    // in the WRONG order (stale-delegations BEFORE orphan-recovery). The fix
    // means this order must still work end-to-end.
    const staleResult = await recoverStaleDelegations(board, new Set<string>());
    expect(staleResult.failed).toHaveLength(0);
    // in_progress task was picked up and its delegatedTo cleared
    expect(staleResult.cleared).toEqual([id]);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBeUndefined();

    // Now orphan recovery moves the task back to pending with preserved metadata.
    const orphanResult = await recoverOrphanedTasks(board, agentId("new-coord"));
    expect(orphanResult.requeued).toEqual([id]);
    expect(board.snapshot().get(id)?.status).toBe("pending");
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBeUndefined();

    // Step 4: new coordinator re-delegates. This must succeed — task_delegate
    // rejects tasks that still have a delegatedTo key. If recovery had missed
    // the in_progress case, this would throw.
    const reDelegateResult = await board.update(id, {
      metadata: { delegatedTo: "fresh-worker" },
    });
    expect(reDelegateResult.ok).toBe(true);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("fresh-worker");
  });

  test("hijack flow — delegate to A, claim by B, B dies, A still alive → task is re-delegatable", async () => {
    // Codex adversarial review round 2 finding: in_progress tasks can be
    // "hijacked" — delegated to agent A but claimed by agent B via
    // task_update(status: in_progress), which calls board.assign(id, B)
    // without validating that B matches delegatedTo. If we key cleanup off
    // metadata.delegatedTo instead of assignedTo, the liveness check runs
    // against A (the wrong identity) and we miss a stale task whose actual
    // worker (B) is dead. Post-unassign the task is pending with a stale
    // delegatedTo marker and task_delegate rejects re-delegation.
    const board = await freshBoard();
    const id = await board.nextId();
    await board.add({ id, description: "Hijacked task" });

    // Step 1: coordinator delegates to agent-A
    await board.update(id, { metadata: { delegatedTo: "agent-A" } });

    // Step 2: agent-B (a DIFFERENT agent) claims the task — this is the hijack.
    // board.assign() does not validate the assignee matches delegatedTo.
    await board.assign(id, agentId("agent-B"));
    expect(board.snapshot().get(id)?.assignedTo).toBe(agentId("agent-B"));
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("agent-A");

    // Step 3: crash. agent-B dies. agent-A is still alive but had nothing
    // to do with the task. liveAgentIds = {"agent-A"}.
    // Pre-fix behavior: needsClear compares delegatedTo ("agent-A") against
    //   liveAgentIds — "agent-A" IS live, so skip. Task left with stale marker.
    // Post-fix: needsClear compares assignedTo ("agent-B") against
    //   liveAgentIds — "agent-B" is NOT live, so clear.
    const staleResult = await recoverStaleDelegations(board, new Set(["agent-A"]));
    expect(staleResult.failed).toHaveLength(0);
    expect(staleResult.cleared).toEqual([id]);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBeUndefined();

    // Step 4: orphan recovery moves the task back to pending.
    const orphanResult = await recoverOrphanedTasks(board, agentId("new-coord"));
    expect(orphanResult.requeued).toEqual([id]);
    expect(board.snapshot().get(id)?.status).toBe("pending");

    // Step 5: re-delegation succeeds — the stale marker was cleared.
    const reDelegate = await board.update(id, { metadata: { delegatedTo: "fresh-worker" } });
    expect(reDelegate.ok).toBe(true);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("fresh-worker");
  });

  test("legitimate in_progress task with live assignee and matching delegatedTo is NOT cleared", async () => {
    // Conservative counterpart to the hijack test: if the assignee is alive
    // the task is legitimately running, so recoveryStaleDelegations should
    // leave the delegatedTo marker alone (even though it's now redundant).
    // This keeps the recovery pass surgical — no unnecessary writes to
    // healthy in-flight work.
    const board = await freshBoard();
    const id = await board.nextId();
    await board.add({ id, description: "Healthy in-flight task" });
    await board.update(id, { metadata: { delegatedTo: "agent-X" } });
    await board.assign(id, agentId("agent-X"));
    expect(board.snapshot().get(id)?.assignedTo).toBe(agentId("agent-X"));

    const result = await recoverStaleDelegations(board, new Set(["agent-X"]));
    // Nothing to clear — assignee is alive.
    expect(result.cleared).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("agent-X");
    expect(board.snapshot().get(id)?.status).toBe("in_progress");
  });

  test("real flow — reverse order (orphan-recovery first) also works", async () => {
    // Same scenario but orphan-recovery runs FIRST. Both orders must work
    // because the contract is advertised as order-independent.
    const board = await freshBoard();
    const id = await board.nextId();
    await board.add({ id, description: "Work to be dispatched" });
    await board.update(id, { metadata: { delegatedTo: "child-worker" } });
    await board.assign(id, agentId("child-worker"));

    // Orphan recovery runs first — task goes in_progress → pending but still
    // has delegatedTo marker.
    const orphanResult = await recoverOrphanedTasks(board, agentId("new-coord"));
    expect(orphanResult.requeued).toEqual([id]);
    expect(board.snapshot().get(id)?.status).toBe("pending");
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBe("child-worker");

    // Stale-delegation cleanup runs second — clears the marker.
    const staleResult = await recoverStaleDelegations(board, new Set<string>());
    expect(staleResult.cleared).toEqual([id]);
    expect(board.snapshot().get(id)?.metadata?.delegatedTo).toBeUndefined();

    // Re-delegation succeeds.
    const reDelegateResult = await board.update(id, {
      metadata: { delegatedTo: "fresh-worker" },
    });
    expect(reDelegateResult.ok).toBe(true);
  });
});
