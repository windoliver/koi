import { describe, expect, test } from "bun:test";
import type {
  KoiError,
  TaskBoardConfig,
  TaskBoardEvent,
  TaskItemInput,
  TaskResult,
} from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

function input(
  id: string,
  deps: readonly string[] = [],
  opts?: { readonly priority?: number; readonly maxRetries?: number },
): TaskItemInput {
  return {
    id: taskItemId(id),
    description: `Task ${id}`,
    dependencies: deps.map(taskItemId),
    priority: opts?.priority,
    maxRetries: opts?.maxRetries,
  };
}

function result(id: string, output = "done"): TaskResult {
  return { taskId: taskItemId(id), output, durationMs: 100 };
}

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
      expect(board.all()).toEqual([]);
    });
  });

  describe("add", () => {
    test("adds a single task with no deps — appears in pending and ready", () => {
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
      // a depends on b, b depends on a (via addAll)
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("b", ["a"]));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      // Now try to add c that depends on b, and then add a dep from a on c
      // Simpler: add self-dependency
      const r3 = r2.value.add({
        id: taskItemId("c"),
        description: "self",
        dependencies: [taskItemId("c")],
      });
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect(r3.error.code).toBe("VALIDATION");
    });

    test("applies default priority 0", () => {
      const board = createTaskBoard();
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.get(taskItemId("a"))?.priority).toBe(0);
    });

    test("applies config maxRetries as default", () => {
      const config: TaskBoardConfig = { maxRetries: 5 };
      const board = createTaskBoard(config);
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.get(taskItemId("a"))?.maxRetries).toBe(5);
    });

    test("task-level maxRetries overrides config", () => {
      const config: TaskBoardConfig = { maxRetries: 5 };
      const board = createTaskBoard(config);
      const r = board.add(input("a", [], { maxRetries: 1 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.get(taskItemId("a"))?.maxRetries).toBe(1);
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

    test("allows dependencies within the same batch", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a"), input("b", ["a"])]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.size()).toBe(2);
    });
  });

  describe("assign", () => {
    test("assigns a ready task — moves to inProgress", () => {
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
      if (r2.ok) return;
      expect(r2.error.code).toBe("VALIDATION");
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
    test("completes an assigned task — unblocks dependents", () => {
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

    test("rejects completing a non-assigned task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.complete(taskItemId("a"), result("a"));
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.code).toBe("VALIDATION");
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
      // Task should be back in pending (retried)
      const task = r3.value.get(taskItemId("a"));
      expect(task?.status).toBe("pending");
      expect(task?.retries).toBe(1);
      expect(r3.value.ready()).toHaveLength(1);
    });

    test("marks failed when retries exhausted", () => {
      const board = createTaskBoard({ maxRetries: 1 });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      // First attempt + fail
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      // retries = 1, maxRetries = 1 → exhausted
      expect(r3.value.get(taskItemId("a"))?.status).toBe("failed");
      expect(r3.value.failed()).toHaveLength(1);
    });

    test("marks immediately failed for non-retryable error", () => {
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
    });
  });

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

    test("ready returns tasks sorted by priority (lowest first)", () => {
      const board = createTaskBoard();
      const r = board.addAll([
        input("a", [], { priority: 5 }),
        input("b", [], { priority: 1 }),
        input("c", [], { priority: 3 }),
      ]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const readyIds = r.value.ready().map((t) => t.id);
      expect(readyIds).toEqual([taskItemId("b"), taskItemId("c"), taskItemId("a")]);
    });
  });

  describe("snapshot restoration", () => {
    test("creates board from snapshot", () => {
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

      // Restore from snapshot
      const items = r3.value.all();
      const completed = r3.value.completed();
      const restored = createTaskBoard(undefined, { items, results: completed });
      expect(restored.size()).toBe(1);
      expect(restored.completed()).toHaveLength(1);
      expect(restored.get(taskItemId("a"))?.status).toBe("completed");
    });
  });

  describe("update", () => {
    test("updates priority on pending task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a", [], { priority: 0 }));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.update(taskItemId("a"), { priority: 10 });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.get(taskItemId("a"))?.priority).toBe(10);
    });

    test("updates description on pending task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.update(taskItemId("a"), { description: "Updated description" });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.value.get(taskItemId("a"))?.description).toBe("Updated description");
    });

    test("updates metadata on assigned task", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const r3 = r2.value.update(taskItemId("a"), { metadata: { tag: "urgent" } });
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      expect(r3.value.get(taskItemId("a"))?.metadata).toEqual({ tag: "urgent" });
    });

    test("rejects update on non-existent task", () => {
      const board = createTaskBoard();
      const r = board.update(taskItemId("nope"), { priority: 1 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_FOUND");
    });

    test("rejects update on completed task", () => {
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
      const r4 = r3.value.update(taskItemId("a"), { priority: 5 });
      expect(r4.ok).toBe(false);
      if (r4.ok) return;
      expect(r4.error.code).toBe("VALIDATION");
    });
  });

  describe("unreachable", () => {
    test("returns tasks blocked by failed dependency", () => {
      const board = createTaskBoard({ maxRetries: 0 });
      const r1 = board.addAll([input("a"), input("b", ["a"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const unreachable = r3.value.unreachable();
      expect(unreachable).toHaveLength(1);
      expect(unreachable[0]?.id).toBe(taskItemId("b"));
    });

    test("returns transitive dependents of failed task", () => {
      const board = createTaskBoard({ maxRetries: 0 });
      const r1 = board.addAll([input("a"), input("b", ["a"]), input("c", ["b"])]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "crash", retryable: false };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      const unreachable = r3.value.unreachable();
      const ids = unreachable.map((t) => t.id);
      expect(ids).toContain(taskItemId("b"));
      expect(ids).toContain(taskItemId("c"));
    });

    test("returns empty when no failures", () => {
      const board = createTaskBoard();
      const r = board.addAll([input("a"), input("b", ["a"])]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.unreachable()).toEqual([]);
    });
  });

  describe("onEvent", () => {
    test("emits task:added event on add", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:added");
    });

    test("emits task:assigned event on assign", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      events.length = 0;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:assigned");
      if (events[0]?.kind === "task:assigned") {
        expect(events[0].taskId).toBe(taskItemId("a"));
        expect(events[0].agentId).toBe(agentId("w1"));
      }
    });

    test("emits task:completed event on complete", () => {
      const events: TaskBoardEvent[] = [];
      const board = createTaskBoard({ onEvent: (e) => events.push(e) });
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      events.length = 0;
      const r3 = r2.value.complete(taskItemId("a"), result("a"));
      expect(r3.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:completed");
    });

    test("emits task:failed event on permanent failure", () => {
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
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:failed");
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
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("task:retried");
      if (events[0]?.kind === "task:retried") {
        expect(events[0].retries).toBe(1);
      }
    });

    test("does not throw when onEvent is undefined", () => {
      const board = createTaskBoard();
      const r = board.add(input("a"));
      expect(r.ok).toBe(true);
    });
  });
});
