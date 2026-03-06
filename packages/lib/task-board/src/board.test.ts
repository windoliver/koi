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
  opts?: {
    readonly priority?: number;
    readonly maxRetries?: number;
    readonly delegation?: "self" | "spawn";
    readonly agentType?: string;
  },
): TaskItemInput {
  return {
    id: taskItemId(id),
    description: `Task ${id}`,
    dependencies: deps.map(taskItemId),
    priority: opts?.priority,
    maxRetries: opts?.maxRetries,
    delegation: opts?.delegation,
    agentType: opts?.agentType,
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
      const r1 = board.add(input("a"));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("b", ["a"]));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
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

  describe("delegation + agentType fields", () => {
    test("round-trips delegation field through add/get", () => {
      const board = createTaskBoard();
      const r = board.add(input("a", [], { delegation: "spawn", agentType: "researcher" }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const item = r.value.get(taskItemId("a"));
      expect(item?.delegation).toBe("spawn");
      expect(item?.agentType).toBe("researcher");
    });

    test("round-trips delegation field through snapshot restore", () => {
      const board = createTaskBoard();
      const r1 = board.add(input("a", [], { delegation: "self" }));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = r1.value.add(input("b", [], { delegation: "spawn", agentType: "coder" }));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      const snapshot = { items: r2.value.all(), results: r2.value.completed() };
      const restored = createTaskBoard(undefined, snapshot);
      expect(restored.get(taskItemId("a"))?.delegation).toBe("self");
      expect(restored.get(taskItemId("b"))?.delegation).toBe("spawn");
      expect(restored.get(taskItemId("b"))?.agentType).toBe("coder");
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
      const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      const err: KoiError = { code: "EXTERNAL", message: "fail", retryable: true };
      const r3 = r2.value.fail(taskItemId("a"), err);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
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

      const items = r3.value.all();
      const completed = r3.value.completed();
      const restored = createTaskBoard(undefined, { items, results: completed });
      expect(restored.size()).toBe(1);
      expect(restored.completed()).toHaveLength(1);
      expect(restored.get(taskItemId("a"))?.status).toBe("completed");
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
    });
  });
});
