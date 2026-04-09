import { describe, expect, test } from "bun:test";
import type { KoiError, Task, TaskBoardEvent, TaskInput, TaskResult, TaskStatus } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

function input(id: string, deps: readonly string[] = []): TaskInput {
  return {
    id: taskItemId(id),
    subject: `Task ${id}`,
    description: `Description for ${id}`,
    dependencies: deps.map(taskItemId),
  };
}

function result(id: string, output = "done"): TaskResult {
  return { taskId: taskItemId(id), output, durationMs: 100 };
}

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

describe("createTaskBoard", () => {
  describe("empty board", () => {
    test("has size 0", () => {
      const board = createTaskBoard();
      expect(board.size()).toBe(0);
    });

    test("returns empty arrays for all queries", () => {
      const board = createTaskBoard();
      expect(board.ready()).toEqual([]);
      expect(board.pending()).toEqual([]);
      expect(board.blocked()).toEqual([]);
      expect(board.inProgress()).toEqual([]);
      expect(board.completed()).toEqual([]);
      expect(board.failed()).toEqual([]);
      expect(board.killed()).toEqual([]);
      expect(board.unreachable()).toEqual([]);
      expect(board.all()).toEqual([]);
    });
  });

  describe("add", () => {
    test("adds a single task — appears in pending and ready", () => {
      const board = createTaskBoard();
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.size()).toBe(1);
      expect(r.value.ready()).toHaveLength(1);
      expect(r.value.ready()[0]?.id).toBe(taskItemId("a"));
      expect(r.value.pending()).toHaveLength(1);
      expect(r.value.get(taskItemId("a"))?.status).toBe("pending");
    });

    test("added task has subject and timestamps", () => {
      const board = createTaskBoard();
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const task = r.value.get(taskItemId("a"));
      expect(task?.subject).toBe("Task a");
      expect(task?.description).toBe("Description for a");
      expect(task?.createdAt).toBeGreaterThan(0);
      expect(task?.updatedAt).toBeGreaterThan(0);
    });

    test("subject defaults to description when omitted", () => {
      const board = createTaskBoard();
      const r = board.add({
        id: taskItemId("x"),
        description: "Do the thing",
        dependencies: [],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const task = r.value.get(taskItemId("x"));
      expect(task?.subject).toBe("Do the thing");
    });

    test("adds a task with deps — blocked until deps completed", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("b", ["a"]));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.size()).toBe(2);
      expect(r2.value.ready()).toHaveLength(1);
      expect(r2.value.ready()[0]?.id).toBe(taskItemId("a"));
      expect(r2.value.blocked()).toHaveLength(1);
      expect(r2.value.blocked()[0]?.id).toBe(taskItemId("b"));
    });

    test("rejects duplicate ID with CONFLICT error", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("a"));
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.code).toBe("CONFLICT");
    });

    test("rejects missing dependency with NOT_FOUND error", () => {
      const board = createTaskBoard();
      const r = board.add(input("a", ["nonexistent"]));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_FOUND");
    });

    test("rejects cycle with VALIDATION error", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("b", ["a"]));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.add({
        id: taskItemId("c"),
        subject: "self",
        description: "self",
        dependencies: [taskItemId("c")],
      });
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect(r3.error.code).toBe("VALIDATION");
    });
  });

  describe("addAll", () => {
    test("adds multiple tasks atomically", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a"), input("b", ["a"]), input("c", ["a"])]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.size()).toBe(3);
      expect(r.value.ready()).toHaveLength(1);
      expect(r.value.blocked()).toHaveLength(2);
    });

    test("rejects batch with internal cycle", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a", ["b"]), input("b", ["a"])]);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("VALIDATION");
    });
  });

  describe("assign", () => {
    test("assigns a ready task — moves to in_progress", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("worker-1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.inProgress()).toHaveLength(1);
      expect(r2.value.inProgress()[0]?.assignedTo).toBe(agentId("worker-1"));
      expect(r2.value.ready()).toHaveLength(0);
    });

    test("rejects assigning a blocked task", () => {
      const board = createTaskBoard();
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("b"), agentId("worker-1"));
      expect(r2.ok).toBe(false);
    });

    test("rejects assigning non-existent task", () => {
      const board = createTaskBoard();
      const r = board.assign(taskItemId("nope"), agentId("worker-1"));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_FOUND");
    });
  });

  describe("complete", () => {
    test("completes an in_progress task — unblocks dependents", () => {
      const board = createTaskBoard();
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.complete(taskItemId("a"), result("a"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.completed()).toHaveLength(1);
      expect(r3.value.ready()).toHaveLength(1);
      expect(r3.value.ready()[0]?.id).toBe(taskItemId("b"));
    });

    test("rejects completing a non-in_progress task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.complete(taskItemId("a"), result("a"));
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.code).toBe("VALIDATION");
    });

    test("rejects mismatched taskResult.taskId", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      // Try to complete task "a" with a result for task "b"
      const r3 = r2.value.complete(taskItemId("a"), result("b"));
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect(r3.error.code).toBe("VALIDATION");
      expect(r3.error.message).toContain("does not match");
    });
  });

  describe("fail", () => {
    test("auto-retries retryable error with retries remaining", () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "timeout", retryable: true };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const task = r3.value.get(taskItemId("a"));
      expect(task?.status).toBe("pending");
      expect(r3.value.ready()).toHaveLength(1);
    });

    test("marks failed for non-retryable error", () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "VALIDATION", message: "bad input", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.status).toBe("failed");
      expect(r3.value.failed()).toHaveLength(1);
    });

    test("maxRetries=0 means no retries — fails immediately", () => {
      const board = createTaskBoard({ maxRetries: 0 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.status).toBe("failed");
    });

    test("maxRetries=1 allows exactly 1 retry", () => {
      const board = createTaskBoard({ maxRetries: 1 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      // First failure → retry (retries becomes 1)
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.status).toBe("pending");
      // Re-assign and fail again → should now be terminal
      const r4 = r3.value.assign(taskItemId("a"), agentId("w1"));
      expect(r4.ok).toBe(true);
      if (!r4.ok) return;
      const r5 = r4.value.fail(taskItemId("a"), err);
      expect(r5.ok).toBe(true);
      if (!r5.ok) return;
      expect(r5.value.get(taskItemId("a"))?.status).toBe("failed");
    });

    test("rejects failing a pending task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      const r2 = r1.value.fail(taskItemId("a"), err);
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.code).toBe("VALIDATION");
      expect(r2.error.message).toContain("expected 'in_progress'");
    });

    test("rejects failing a completed task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.complete(taskItemId("a"), result("a"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      const r4 = r3.value.fail(taskItemId("a"), err);
      expect(r4.ok).toBe(false);
      if (r4.ok) return;
      expect(r4.error.code).toBe("VALIDATION");
    });

    test("metadata cannot override retry count", () => {
      const board = createTaskBoard({ maxRetries: 1 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      // First retry succeeds (retries: 0 → 1)
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.retries).toBe(1);
      // Try to cheat by resetting retries via metadata update
      const r4 = r3.value.update(taskItemId("a"), { metadata: { retries: 0 } });
      expect(r4.ok).toBe(true);
      if (!r4.ok) return;
      // Task.retries should still be 1 (metadata doesn't affect board-managed field)
      expect(r4.value.get(taskItemId("a"))?.retries).toBe(1);
      // Re-assign and fail again — should be terminal (retries=1 >= maxRetries=1)
      const r5 = r4.value.assign(taskItemId("a"), agentId("w1"));
      expect(r5.ok).toBe(true);
      if (!r5.ok) return;
      const r6 = r5.value.fail(taskItemId("a"), err);
      expect(r6.ok).toBe(true);
      if (!r6.ok) return;
      expect(r6.value.get(taskItemId("a"))?.status).toBe("failed");
    });

    test("maxRetries=3 allows exactly 3 retries", () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      // let justified: tracking board through retry cycle
      let current = board;
      const r1 = current.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      current = r1.value;

      // 3 retries should succeed
      for (const i of [1, 2, 3]) {
        const ra = current.assign(taskItemId("a"), agentId("w1"));
        expect(ra.ok).toBe(true);
        if (!ra.ok) return;
        const rf = ra.value.fail(taskItemId("a"), err);
        expect(rf.ok).toBe(true);
        if (!rf.ok) return;
        if (i < 3) {
          expect(rf.value.get(taskItemId("a"))?.status).toBe("pending");
        }
        current = rf.value;
      }
      // After 3 retries, 4th failure should be terminal
      const ra = current.assign(taskItemId("a"), agentId("w1"));
      expect(ra.ok).toBe(true);
      if (!ra.ok) return;
      const rf = ra.value.fail(taskItemId("a"), err);
      expect(rf.ok).toBe(true);
      if (!rf.ok) return;
      expect(rf.value.get(taskItemId("a"))?.status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Kill
  // ---------------------------------------------------------------------------

  describe("kill", () => {
    test("kills a pending task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.kill(taskItemId("a"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.get(taskItemId("a"))?.status).toBe("killed");
      expect(r2.value.killed()).toHaveLength(1);
    });

    test("kills an in_progress task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.kill(taskItemId("a"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.status).toBe("killed");
    });

    test("rejects killing a completed task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.complete(taskItemId("a"), result("a"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const r4 = r3.value.kill(taskItemId("a"));
      expect(r4.ok).toBe(false);
      if (r4.ok) return;
      expect(r4.error.code).toBe("VALIDATION");
    });

    test("rejects killing an already-killed task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.kill(taskItemId("a"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.kill(taskItemId("a"));
      expect(r3.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 5×5 transition matrix (via board operations)
  // ---------------------------------------------------------------------------

  describe("transition matrix", () => {
    // Helper to get a board with a task in a specific state
    async function boardWithTaskInState(
      status: TaskStatus,
    ): Promise<import("@koi/core").TaskBoard | undefined> {
      const board = createTaskBoard({ maxRetries: 0 });
      const r1 = board.add(input("t"));
      if (!r1.ok) return undefined;

      switch (status) {
        case "pending":
          return r1.value;
        case "in_progress": {
          const r2 = r1.value.assign(taskItemId("t"), agentId("w1"));
          return r2.ok ? r2.value : undefined;
        }
        case "completed": {
          const r2 = r1.value.assign(taskItemId("t"), agentId("w1"));
          if (!r2.ok) return undefined;
          const r3 = r2.value.complete(taskItemId("t"), result("t"));
          return r3.ok ? r3.value : undefined;
        }
        case "failed": {
          const r2 = r1.value.assign(taskItemId("t"), agentId("w1"));
          if (!r2.ok) return undefined;
          const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: false };
          const r3 = r2.value.fail(taskItemId("t"), err);
          return r3.ok ? r3.value : undefined;
        }
        case "killed": {
          const r2 = r1.value.kill(taskItemId("t"));
          return r2.ok ? r2.value : undefined;
        }
      }
    }

    // Transitions from terminal states should all fail
    const terminalStates: TaskStatus[] = ["completed", "failed", "killed"];
    for (const state of terminalStates) {
      test(`cannot assign from ${state}`, async () => {
        const board = await boardWithTaskInState(state);
        expect(board).toBeDefined();
        if (board === undefined) return;
        const r = board.assign(taskItemId("t"), agentId("w1"));
        expect(r.ok).toBe(false);
      });

      test(`cannot complete from ${state} (already terminal)`, async () => {
        const board = await boardWithTaskInState(state);
        expect(board).toBeDefined();
        if (board === undefined) return;
        const r = board.complete(taskItemId("t"), result("t"));
        expect(r.ok).toBe(false);
      });

      test(`cannot kill from ${state}`, async () => {
        const board = await boardWithTaskInState(state);
        expect(board).toBeDefined();
        if (board === undefined) return;
        const r = board.kill(taskItemId("t"));
        expect(r.ok).toBe(false);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Unreachable cascade events
  // ---------------------------------------------------------------------------

  describe("task:unreachable cascade", () => {
    test("A→B: A fails → task:unreachable for B", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;

      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(1);
      expect(unreachableEvents[0]).toEqual({
        kind: "task:unreachable",
        taskId: taskItemId("b"),
        blockedBy: taskItemId("a"),
      });
      expect(r3.value.unreachable()).toHaveLength(1);
    });

    test("A→B: A killed → task:unreachable for B", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      events.length = 0;
      const r2 = r1.value.kill(taskItemId("a"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(1);
      expect(unreachableEvents[0]).toEqual({
        kind: "task:unreachable",
        taskId: taskItemId("b"),
        blockedBy: taskItemId("a"),
      });
    });

    test("A→B→C: A fails → task:unreachable for B AND C (transitive)", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b", ["a"]), input("c", ["b"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;

      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(2);
      const unreachableIds = unreachableEvents.map(
        (e) => (e as { readonly taskId: string }).taskId,
      );
      expect(unreachableIds).toContain(taskItemId("b"));
      expect(unreachableIds).toContain(taskItemId("c"));
      expect(r3.value.unreachable()).toHaveLength(2);
    });

    test("A→B, A→C: A fails → task:unreachable for both B and C", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b", ["a"]), input("c", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;

      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(2);
    });

    test("A→B: A fails, B already completed → NO unreachable event", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b")]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      // Complete B first (it has no deps in this version — we add dep dynamically)
      // Actually, let's create a scenario: A and B are independent, both complete,
      // then C depends on A. Kill A — C is unreachable, B is not.
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.assign(taskItemId("b"), agentId("w2"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const r4 = r3.value.complete(taskItemId("b"), result("b"));
      expect(r4.ok).toBe(true);
      if (!r4.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r5 = r4.value.fail(taskItemId("a"), err);
      expect(r5.ok).toBe(true);
      if (!r5.ok) return;

      // B was already completed, so no unreachable events (B doesn't depend on A)
      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot round-trip
  // ---------------------------------------------------------------------------

  describe("snapshot", () => {
    test("round-trips with new fields (subject, timestamps)", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.complete(taskItemId("a"), result("a", "output"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;

      const items = r3.value.all();
      const completed = r3.value.completed();
      const restored = createTaskBoard(undefined, { items, results: completed });
      expect(restored.size()).toBe(1);
      expect(restored.completed()).toHaveLength(1);
      const task = restored.get(taskItemId("a"));
      expect(task?.status).toBe("completed");
      expect(task?.subject).toBe("Task a");
      expect(task?.createdAt).toBeGreaterThan(0);
    });

    test("backward compatibility: old snapshots without subject/timestamps", () => {
      // Simulate an old snapshot that lacks subject, createdAt, updatedAt
      const oldSnapshot = {
        items: [
          {
            id: taskItemId("legacy"),
            description: "Old task",
            dependencies: [],
            status: "pending" as const,
          },
        ],
        results: [],
      };
      // @ts-expect-error — deliberately testing backward compat with missing fields
      const restored = createTaskBoard(undefined, oldSnapshot);
      const task = restored.get(taskItemId("legacy"));
      expect(task).toBeDefined();
      expect(task?.description).toBe("Old task");
      // New fields should have defaults
      expect(task?.subject).toBe("");
      expect(task?.createdAt).toBe(0);
      expect(task?.updatedAt).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  describe("events", () => {
    test("emits task:added event", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      board.add(input("a"));
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:added");
    });

    test("emits task:killed event", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      events.length = 0;
      r1.value.kill(taskItemId("a"));
      expect(events.some((e) => e.kind === "task:killed")).toBe(true);
    });

    test("consumer error in onEvent does not crash mutation", () => {
      const board = createTaskBoard({
        onEvent: () => {
          throw new Error("consumer bug");
        },
      });
      // Should not throw despite consumer error
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
    });

    test("emits task:retried event on auto-retry", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 3, onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "timeout", retryable: true };
      r2.value.fail(taskItemId("a"), err);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:retried");
    });
  });

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  describe("queries", () => {
    test("dependentsOf returns tasks that depend on given task", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a"), input("b", ["a"]), input("c", ["a"]), input("d", ["b"])]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const deps = r.value.dependentsOf(taskItemId("a"));
      const ids = deps.map((t) => t.id);
      expect(ids).toContain(taskItemId("b"));
      expect(ids).toContain(taskItemId("c"));
      expect(ids).not.toContain(taskItemId("d"));
    });

    test("update rejects terminal tasks", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.kill(taskItemId("a"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.update(taskItemId("a"), { subject: "new" });
      expect(r3.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 9A: update() dedicated tests
  // ---------------------------------------------------------------------------

  describe("update", () => {
    test("updates subject on a pending task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.update(taskItemId("a"), { subject: "New Subject" });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const task = r2.value.get(taskItemId("a"));
      expect(task?.subject).toBe("New Subject");
      expect(task?.description).toBe("Description for a");
    });

    test("updates description on an in_progress task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.update(taskItemId("a"), { description: "Updated desc" });
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.description).toBe("Updated desc");
    });

    test("rejects update on non-existent task", () => {
      const board = createTaskBoard();
      const r = board.update(taskItemId("nope"), { subject: "x" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_FOUND");
    });

    test("empty patch succeeds as no-op (updatedAt still advances)", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const before = r1.value.get(taskItemId("a"));
      const r2 = r1.value.update(taskItemId("a"), {});
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const after = r2.value.get(taskItemId("a"));
      expect(after?.subject).toBe(before?.subject);
      expect(after?.description).toBe(before?.description);
      expect(after?.version).toBe((before?.version ?? 0) + 1);
    });

    test("preserves status and retries on update", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.update(taskItemId("a"), { subject: "Updated" });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const task = r2.value.get(taskItemId("a"));
      expect(task?.status).toBe("pending");
      expect(task?.retries).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 10A: complete event coverage
  // ---------------------------------------------------------------------------

  describe("events — complete coverage", () => {
    test("emits task:assigned event", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      events.length = 0;
      r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:assigned");
    });

    test("emits task:completed event", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      r2.value.complete(taskItemId("a"), result("a"));
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:completed");
    });

    test("emits task:failed event on terminal failure", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      r2.value.fail(taskItemId("a"), err);
      expect(events.some((e) => e.kind === "task:failed")).toBe(true);
    });

    test("events fire in order: task:failed then task:unreachable", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      r2.value.fail(taskItemId("a"), err);
      // task:failed must come before task:unreachable
      const failIdx = events.findIndex((e) => e.kind === "task:failed");
      const unreachIdx = events.findIndex((e) => e.kind === "task:unreachable");
      expect(failIdx).toBeGreaterThanOrEqual(0);
      expect(unreachIdx).toBeGreaterThanOrEqual(0);
      expect(failIdx).toBeLessThan(unreachIdx);
    });

    test("onEventError is called when onEvent throws", () => {
      const errors: unknown[] = [];
      const board = createTaskBoard({
        onEvent: () => {
          throw new Error("handler bug");
        },
        onEventError: (err) => {
          errors.push(err);
        },
      });
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 11A: addAll batch edge cases
  // ---------------------------------------------------------------------------

  describe("addAll — batch edge cases", () => {
    test("rejects duplicate IDs within a batch", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a"), input("a")]);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("CONFLICT");
    });

    test("empty batch returns ok with unchanged board", () => {
      const board = createTaskBoard();
      const r = board.addAll([]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.size()).toBe(0);
    });

    test("batch with dead deps emits unreachable events", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ maxRetries: 0, onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.kill(taskItemId("a"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      // Add tasks that depend on the killed task
      const r3 = r2.value.addAll([input("b", ["a"]), input("c", ["a"])]);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.unreachable()).toHaveLength(2);
      // Verify task:unreachable events were emitted for both
      const unreachableEvents = events.filter((e) => e.kind === "task:unreachable");
      expect(unreachableEvents).toHaveLength(2);
      const unreachableIds = unreachableEvents.map(
        (e) => (e as { readonly taskId: string }).taskId,
      );
      expect(unreachableIds).toContain(taskItemId("b"));
      expect(unreachableIds).toContain(taskItemId("c"));
    });

    test("batch with mixed internal and external deps", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("ext"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      // Batch: "a" depends on existing "ext", "b" depends on batch-internal "a"
      const r2 = r1.value.addAll([input("a", ["ext"]), input("b", ["a"])]);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.size()).toBe(3);
      expect(r2.value.blocked()).toHaveLength(2);
      expect(r2.value.ready()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 1A: maxInProgressPerOwner
  // ---------------------------------------------------------------------------

  describe("maxInProgressPerOwner", () => {
    test("allows assignment when under limit", () => {
      const board = createTaskBoard({ maxInProgressPerOwner: 2 });
      const r1 = board.addAll([input("a"), input("b")]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
    });

    test("rejects assignment when at limit", () => {
      const board = createTaskBoard({ maxInProgressPerOwner: 1 });
      const r1 = board.addAll([input("a"), input("b")]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.assign(taskItemId("b"), agentId("w1"));
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect(r3.error.code).toBe("VALIDATION");
      expect(r3.error.message).toContain("max: 1");
    });

    test("different agents have independent limits", () => {
      const board = createTaskBoard({ maxInProgressPerOwner: 1 });
      const r1 = board.addAll([input("a"), input("b")]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      // Different agent — should be allowed
      const r3 = r2.value.assign(taskItemId("b"), agentId("w2"));
      expect(r3.ok).toBe(true);
    });

    test("unlimited when config is undefined", () => {
      const board = createTaskBoard();
      const r1 = board.addAll([input("a"), input("b"), input("c")]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.assign(taskItemId("b"), agentId("w1"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const r4 = r3.value.assign(taskItemId("c"), agentId("w1"));
      expect(r4.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 2A: version field
  // ---------------------------------------------------------------------------

  describe("version tracking", () => {
    test("new task starts at version 0", () => {
      const board = createTaskBoard();
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.get(taskItemId("a"))?.version).toBe(0);
    });

    test("assign increments version", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.get(taskItemId("a"))?.version).toBe(1);
    });

    test("complete increments version", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.complete(taskItemId("a"), result("a"));
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.version).toBe(2);
    });

    test("retry increments version", () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "timeout", retryable: true };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.version).toBe(2);
    });

    test("update increments version", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.update(taskItemId("a"), { subject: "new" });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.get(taskItemId("a"))?.version).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// activeForm lifecycle
// ---------------------------------------------------------------------------

describe("activeForm", () => {
  test("task created with activeForm retains it in pending state", () => {
    const board = createTaskBoard();
    const r = board.add({
      id: taskItemId("a"),
      description: "Task A",
      activeForm: "Planning task A",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.get(taskItemId("a"))?.activeForm).toBe("Planning task A");
  });

  test("update() sets activeForm on a pending task", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.update(taskItemId("a"), { activeForm: "Working on A" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.get(taskItemId("a"))?.activeForm).toBe("Working on A");
  });

  test("update() preserves activeForm when not mentioned in patch", () => {
    const board = createTaskBoard();
    const r1 = board.add({
      id: taskItemId("a"),
      description: "Task A",
      activeForm: "Planning task A",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.update(taskItemId("a"), { subject: "Updated subject" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.get(taskItemId("a"))?.activeForm).toBe("Planning task A");
  });

  test("update() clears activeForm when patch.activeForm is explicitly undefined", () => {
    const board = createTaskBoard();
    const r1 = board.add({
      id: taskItemId("a"),
      description: "Task A",
      activeForm: "Planning task A",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // Explicit undefined in patch clears the field
    const r2 = r1.value.update(taskItemId("a"), { activeForm: undefined });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.get(taskItemId("a"))?.activeForm).toBeUndefined();
  });

  test("activeForm is cleared when task transitions to completed", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "Task A", activeForm: "Doing A" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const r3 = r2.value.complete(taskItemId("a"), result("a"));
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.get(taskItemId("a"))?.activeForm).toBeUndefined();
  });

  test("activeForm is cleared when task is killed", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "Task A", activeForm: "Doing A" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const r3 = r2.value.kill(taskItemId("a"));
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.get(taskItemId("a"))?.activeForm).toBeUndefined();
  });

  test("activeForm is cleared when task fails (terminal)", () => {
    const board = createTaskBoard({ maxRetries: 0 });
    const r1 = board.add({ id: taskItemId("a"), description: "Task A", activeForm: "Doing A" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
    const r3 = r2.value.fail(taskItemId("a"), err);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.get(taskItemId("a"))?.status).toBe("failed");
    expect(r3.value.get(taskItemId("a"))?.activeForm).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task.startedAt — accurate run-duration anchor (#1557 review fix 7A)
// ---------------------------------------------------------------------------
//
// startedAt is set on every pending → in_progress transition and is NOT
// bumped by activeForm (or other update()) patches. Consumers compute
// durationMs from startedAt rather than updatedAt so the metric reflects
// the real wall-clock running time, not "time since last patch".

describe("startedAt", () => {
  test("created tasks have no startedAt until assigned", () => {
    const board = createTaskBoard();
    const r = board.add(input("a"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.get(taskItemId("a"))?.startedAt).toBeUndefined();
  });

  test("assign sets startedAt on pending → in_progress", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const before = Date.now();
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    const after = Date.now();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const startedAt = r2.value.get(taskItemId("a"))?.startedAt;
    expect(startedAt).toBeDefined();
    // Bound the timestamp on both sides — guards against clock drift / wrong field copy
    expect(startedAt as number).toBeGreaterThanOrEqual(before);
    expect(startedAt as number).toBeLessThanOrEqual(after);
  });

  test("update(activeForm) does NOT bump startedAt", async () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const startedAt0 = r2.value.get(taskItemId("a"))?.startedAt;

    // Tiny delay so updatedAt would differ if it were being copied
    await new Promise((resolve) => setTimeout(resolve, 5));

    const r3 = r2.value.update(taskItemId("a"), { activeForm: "Working hard" });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const t3 = r3.value.get(taskItemId("a"));
    // startedAt is preserved — only updatedAt should advance
    expect(t3?.startedAt).toBe(startedAt0);
    expect(t3?.updatedAt ?? 0).toBeGreaterThanOrEqual(startedAt0 ?? 0);
  });

  test("retry path resets startedAt on the next assign", async () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const r1 = board.add(input("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const startedAt0 = r2.value.get(taskItemId("a"))?.startedAt;

    // Retryable failure puts the task back to pending; startedAt is left alone
    // because the task may be inspected before re-assignment.
    const err: KoiError = { code: "EXTERNAL", message: "transient", retryable: true };
    const r3 = r2.value.fail(taskItemId("a"), err);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.get(taskItemId("a"))?.status).toBe("pending");
    expect(r3.value.get(taskItemId("a"))?.startedAt).toBe(startedAt0);

    // Tiny delay so the next startedAt is observably different
    await new Promise((resolve) => setTimeout(resolve, 5));

    const r4 = r3.value.assign(taskItemId("a"), agentId("w1"));
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;
    const startedAt1 = r4.value.get(taskItemId("a"))?.startedAt;
    expect(startedAt1).toBeDefined();
    expect(startedAt1).not.toBe(startedAt0);
    expect(startedAt1 as number).toBeGreaterThan(startedAt0 ?? 0);
  });

  test("snapshot loader backfills startedAt from updatedAt for in_progress tasks", () => {
    // Simulate a snapshot from before the field existed: in_progress task with no startedAt.
    // The loader should backfill it to updatedAt (best-effort approximation).
    const legacyTask: Task = {
      id: taskItemId("a"),
      subject: "Legacy",
      description: "Pre-existing in_progress task",
      dependencies: [],
      retries: 0,
      version: 1,
      status: "in_progress",
      assignedTo: agentId("w1"),
      createdAt: 1000,
      updatedAt: 5000,
    };
    const board = createTaskBoard(undefined, { items: [legacyTask], results: [] });
    expect(board.get(taskItemId("a"))?.startedAt).toBe(5000);
  });

  test("snapshot loader leaves startedAt undefined for non-in_progress tasks", () => {
    // Pending and terminal tasks have no startedAt, even on backfill.
    const legacyPending: Task = {
      id: taskItemId("a"),
      subject: "Pending",
      description: "Pending",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "pending",
      createdAt: 1000,
      updatedAt: 5000,
    };
    const legacyCompleted: Task = {
      id: taskItemId("b"),
      subject: "Done",
      description: "Done",
      dependencies: [],
      retries: 0,
      version: 2,
      status: "completed",
      createdAt: 1000,
      updatedAt: 9000,
    };
    const board = createTaskBoard(undefined, {
      items: [legacyPending, legacyCompleted],
      results: [],
    });
    expect(board.get(taskItemId("a"))?.startedAt).toBeUndefined();
    expect(board.get(taskItemId("b"))?.startedAt).toBeUndefined();
  });

  test("snapshot loader preserves explicit startedAt over backfill", () => {
    const task: Task = {
      id: taskItemId("a"),
      subject: "Modern",
      description: "Has startedAt explicitly",
      dependencies: [],
      retries: 0,
      version: 2,
      status: "in_progress",
      assignedTo: agentId("w1"),
      createdAt: 1000,
      updatedAt: 9000,
      startedAt: 7000,
    };
    const board = createTaskBoard(undefined, { items: [task], results: [] });
    // 7000, not 9000 — explicit field wins
    expect(board.get(taskItemId("a"))?.startedAt).toBe(7000);
  });
});

// ---------------------------------------------------------------------------
// blockedBy + cache (#1557 review fix 14A)
// ---------------------------------------------------------------------------

describe("blockedBy", () => {
  test("returns undefined for tasks with no dependencies", () => {
    const r = createTaskBoard().add(input("a"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.blockedBy(taskItemId("a"))).toBeUndefined();
  });

  test("returns the first incomplete dep for a pending task", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b"));
    if (!r2.ok) return;
    const r3 = r2.value.add(input("c", ["a", "b"]));
    if (!r3.ok) return;
    expect(r3.value.blockedBy(taskItemId("c"))).toBe(taskItemId("a"));
  });

  test("returns the next incomplete dep after the first completes", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b"));
    if (!r2.ok) return;
    const r3 = r2.value.add(input("c", ["a", "b"]));
    if (!r3.ok) return;
    const r4 = r3.value.assign(taskItemId("a"), agentId("w1"));
    if (!r4.ok) return;
    const r5 = r4.value.complete(taskItemId("a"), result("a"));
    if (!r5.ok) return;
    // Now `a` is complete; `b` is the blocker
    expect(r5.value.blockedBy(taskItemId("c"))).toBe(taskItemId("b"));
  });

  test("returns undefined when all deps are completed (task is ready)", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b", ["a"]));
    if (!r2.ok) return;
    const r3 = r2.value.assign(taskItemId("a"), agentId("w1"));
    if (!r3.ok) return;
    const r4 = r3.value.complete(taskItemId("a"), result("a"));
    if (!r4.ok) return;
    expect(r4.value.blockedBy(taskItemId("b"))).toBeUndefined();
  });

  test("returns undefined for non-pending tasks", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) return;
    // in_progress → no blocker
    expect(r2.value.blockedBy(taskItemId("a"))).toBeUndefined();
  });

  test("returns undefined for unknown task IDs", () => {
    const board = createTaskBoard();
    expect(board.blockedBy(taskItemId("nonexistent"))).toBeUndefined();
  });

  test("repeated calls on the same snapshot return consistent answers (cache hit)", () => {
    // The cache is internal — we can't directly observe hits, but we CAN verify
    // that repeated calls return the same value AND that mutating the board
    // (which produces a new snapshot) returns a possibly different value.
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b", ["a"]));
    if (!r2.ok) return;

    // Pre-completion: 5 calls all return "a"
    for (let i = 0; i < 5; i++) {
      expect(r2.value.blockedBy(taskItemId("b"))).toBe(taskItemId("a"));
    }

    // After completion (new board snapshot), the cache is fresh
    const r3 = r2.value.assign(taskItemId("a"), agentId("w1"));
    if (!r3.ok) return;
    const r4 = r3.value.complete(taskItemId("a"), result("a"));
    if (!r4.ok) return;
    expect(r4.value.blockedBy(taskItemId("b"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lazy reverse adjacency (#1557 review fix 13A)
// ---------------------------------------------------------------------------
//
// The reverse adjacency map is built only when fail()/kill()/dependentsOf() is
// called — never on assign/complete/update/etc. We can't directly observe "did
// the build happen" from outside the closure, but we CAN verify the queries
// that DO need it still work correctly. Combined with the existing 100+ board
// tests (which cover all mutation paths), this proves the lazy build doesn't
// break anything.

describe("lazy reverse adjacency", () => {
  test("dependentsOf works after a series of assign-only mutations", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b", ["a"]));
    if (!r2.ok) return;
    const r3 = r2.value.add(input("c", ["a"]));
    if (!r3.ok) return;
    // The reverse adj has not been built yet — these mutations don't need it.
    // Now ask for dependentsOf — it should build the adj on first call.
    expect(r3.value.dependentsOf(taskItemId("a"))).toHaveLength(2);
  });

  test("kill cascade still computes unreachable correctly", () => {
    const board = createTaskBoard();
    const r1 = board.add(input("a"));
    if (!r1.ok) return;
    const r2 = r1.value.add(input("b", ["a"]));
    if (!r2.ok) return;
    const r3 = r2.value.add(input("c", ["b"]));
    if (!r3.ok) return;
    // Kill `a` — `b` and `c` become unreachable. This exercises the
    // lazy reverse adj for the first time.
    const r4 = r3.value.kill(taskItemId("a"));
    if (!r4.ok) return;
    const unreachable = r4.value.unreachable().map((t) => t.id);
    expect(unreachable).toContain(taskItemId("b"));
    expect(unreachable).toContain(taskItemId("c"));
  });
});

// ---------------------------------------------------------------------------
// Pending-only-marker invariant for metadata.delegatedTo (#1557 review L0u fix)
// ---------------------------------------------------------------------------
//
// `delegatedTo` means "delegated but not yet claimed". Once a task is
// claimed (assign), the marker is stale history. The board enforces this
// invariant at every entry to / exit from `in_progress`:
//
//   - transitionTask(in_progress): strips delegatedTo on claim
//   - unassign(): strips delegatedTo on in_progress → pending
//   - fail() retry branch: strips delegatedTo on in_progress → pending
//   - snapshot loader: normalizes legacy in_progress tasks with stale markers
//
// Combined with task_delegate being the only way to SET delegatedTo (and
// only on pending tasks), this guarantees that in_progress tasks NEVER
// carry a delegation marker. The @koi/spawn-tools recovery helper can
// therefore skip in_progress tasks entirely.

describe("metadata.delegatedTo pending-only invariant", () => {
  test("assign() strips delegatedTo when claiming a delegated pending task", () => {
    const board = createTaskBoard();
    const r1 = board.add({
      id: taskItemId("a"),
      description: "Delegated task",
      metadata: { delegatedTo: "child-worker", kind: "research", priority: 3 },
    });
    if (!r1.ok) return;
    expect(r1.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBe("child-worker");

    const r2 = r1.value.assign(taskItemId("a"), agentId("child-worker"));
    if (!r2.ok) return;
    const claimed = r2.value.get(taskItemId("a"));
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.assignedTo).toBe(agentId("child-worker"));
    // delegatedTo is GONE, but other metadata keys are preserved.
    expect(claimed?.metadata !== undefined && "delegatedTo" in claimed.metadata).toBe(false);
    expect(claimed?.metadata?.kind).toBe("research");
    expect(claimed?.metadata?.priority).toBe(3);
  });

  test("assign() leaves metadata alone when no delegatedTo was present", () => {
    const board = createTaskBoard();
    const r1 = board.add({
      id: taskItemId("a"),
      description: "No delegation",
      metadata: { kind: "direct", tag: "quick" },
    });
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("worker"));
    if (!r2.ok) return;
    const task = r2.value.get(taskItemId("a"));
    expect(task?.metadata).toEqual({ kind: "direct", tag: "quick" });
  });

  test("assign() leaves undefined metadata as undefined", () => {
    const board = createTaskBoard();
    const r1 = board.add({ id: taskItemId("a"), description: "No metadata" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("worker"));
    if (!r2.ok) return;
    expect(r2.value.get(taskItemId("a"))?.metadata).toBeUndefined();
  });

  test("assign() collapses metadata to undefined when delegatedTo was the only key", () => {
    const board = createTaskBoard();
    const r1 = board.add({
      id: taskItemId("a"),
      description: "Lone delegation marker",
      metadata: { delegatedTo: "worker" },
    });
    if (!r1.ok) return;
    const r2 = r1.value.assign(taskItemId("a"), agentId("worker"));
    if (!r2.ok) return;
    // Stripping the only key leaves an empty object — the helper collapses
    // that to undefined so downstream serializers don't see dangling {}.
    expect(r2.value.get(taskItemId("a"))?.metadata).toBeUndefined();
  });

  test("unassign() strips delegatedTo from in_progress → pending transition", () => {
    // This path is primarily for snapshots loaded from a pre-invariant version
    // of koi that left delegatedTo set on live in_progress tasks. unassign()
    // is defense in depth — new in_progress tasks wouldn't have the marker
    // because assign() already stripped it.
    const legacyTask: Task = {
      id: taskItemId("a"),
      subject: "Legacy",
      description: "Pre-invariant in_progress task",
      dependencies: [],
      retries: 0,
      version: 1,
      status: "in_progress",
      assignedTo: agentId("old-worker"),
      // Simulate legacy state BEFORE the snapshot backfill would see it.
      // We construct the Task directly and insert it via the snapshot loader
      // below, asserting the loader normalized it.
      metadata: { delegatedTo: "old-worker", kind: "legacy" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    const board = createTaskBoard(undefined, { items: [legacyTask], results: [] });
    // Snapshot loader should already have stripped the marker on load.
    expect(board.get(taskItemId("a"))?.metadata?.delegatedTo).toBeUndefined();
    expect(board.get(taskItemId("a"))?.metadata?.kind).toBe("legacy");

    // But unassign() is also defensive — if some future caller somehow
    // gets delegatedTo back onto an in_progress task (e.g. via a direct
    // update() call) the unassign path strips it.
    const r = board.unassign(taskItemId("a"));
    if (!r.ok) return;
    expect(r.value.get(taskItemId("a"))?.status).toBe("pending");
    expect(r.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBeUndefined();
    expect(r.value.get(taskItemId("a"))?.metadata?.kind).toBe("legacy");
  });

  test("fail() retry branch strips delegatedTo when retrying back to pending", () => {
    // Same defense-in-depth — assign() already strips, but fail-retry is
    // the other in_progress → pending exit and must also enforce the
    // invariant for legacy state or update-side leakage.
    const legacyTask: Task = {
      id: taskItemId("a"),
      subject: "Legacy",
      description: "Pre-invariant in_progress task",
      dependencies: [],
      retries: 0,
      version: 1,
      status: "in_progress",
      assignedTo: agentId("old-worker"),
      metadata: { delegatedTo: "old-worker", kind: "legacy" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    const board = createTaskBoard({ maxRetries: 3 }, { items: [legacyTask], results: [] });
    // Snapshot loader already stripped, so replant the marker via a direct
    // update() to simulate the defense-in-depth scenario.
    const rSeed = board.update(taskItemId("a"), {
      metadata: { delegatedTo: "old-worker", kind: "legacy" },
    });
    if (!rSeed.ok) return;
    expect(rSeed.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBe("old-worker");

    // Retryable failure → task goes back to pending. delegatedTo must be stripped.
    const err: KoiError = { code: "EXTERNAL", message: "transient", retryable: true };
    const r = rSeed.value.fail(taskItemId("a"), err);
    if (!r.ok) return;
    const retried = r.value.get(taskItemId("a"));
    expect(retried?.status).toBe("pending");
    expect(retried?.retries).toBe(1);
    expect(retried?.metadata?.delegatedTo).toBeUndefined();
    expect(retried?.metadata?.kind).toBe("legacy");
  });

  test("snapshot loader strips delegatedTo from legacy in_progress tasks", () => {
    const legacyInProgress: Task = {
      id: taskItemId("a"),
      subject: "Legacy in_progress",
      description: "Has stale delegatedTo",
      dependencies: [],
      retries: 0,
      version: 1,
      status: "in_progress",
      assignedTo: agentId("w1"),
      metadata: { delegatedTo: "stale-worker", kind: "research" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    const legacyPending: Task = {
      id: taskItemId("b"),
      subject: "Legacy pending",
      description: "Has legit delegatedTo",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "pending",
      // Pending tasks' delegation markers are legitimate — loader leaves them alone.
      metadata: { delegatedTo: "intended-worker" },
      createdAt: 1000,
      updatedAt: 1000,
    };
    const board = createTaskBoard(undefined, {
      items: [legacyInProgress, legacyPending],
      results: [],
    });
    // in_progress → stripped
    expect(board.get(taskItemId("a"))?.metadata?.delegatedTo).toBeUndefined();
    expect(board.get(taskItemId("a"))?.metadata?.kind).toBe("research");
    // pending → preserved
    expect(board.get(taskItemId("b"))?.metadata?.delegatedTo).toBe("intended-worker");
  });

  test("full round trip: delegate → claim → retry → re-delegate works without manual cleanup", () => {
    // End-to-end verification of the invariant. No recovery helper calls —
    // the board alone is sufficient to keep a task re-delegatable across
    // the full state machine.
    const board = createTaskBoard({ maxRetries: 3 });
    const r1 = board.add({
      id: taskItemId("a"),
      description: "End-to-end invariant test",
    });
    if (!r1.ok) return;

    // Coordinator delegates
    const r2 = r1.value.update(taskItemId("a"), {
      metadata: { delegatedTo: "child-worker" },
    });
    if (!r2.ok) return;
    expect(r2.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBe("child-worker");

    // Child claims — marker is stripped
    const r3 = r2.value.assign(taskItemId("a"), agentId("child-worker"));
    if (!r3.ok) return;
    expect(r3.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBeUndefined();

    // Child fails with retry — marker stays stripped
    const err: KoiError = { code: "EXTERNAL", message: "transient", retryable: true };
    const r4 = r3.value.fail(taskItemId("a"), err);
    if (!r4.ok) return;
    expect(r4.value.get(taskItemId("a"))?.status).toBe("pending");
    expect(r4.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBeUndefined();

    // Coordinator re-delegates — succeeds because the marker was cleared
    const r5 = r4.value.update(taskItemId("a"), {
      metadata: { delegatedTo: "fresh-worker" },
    });
    if (!r5.ok) return;
    expect(r5.value.get(taskItemId("a"))?.metadata?.delegatedTo).toBe("fresh-worker");
  });
});
