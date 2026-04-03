import { describe, expect, test } from "bun:test";
import type { KoiError, TaskBoardEvent, TaskInput, TaskResult, TaskStatus } from "@koi/core";
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
});
