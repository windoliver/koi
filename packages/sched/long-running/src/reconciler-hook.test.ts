import { describe, expect, test } from "bun:test";
import type { TaskReconcileAction, TaskReconciler } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "@koi/task-board";
import { createReconcilerHook } from "./reconciler-hook.js";

function setupBoard(
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly deps?: readonly string[];
  }>,
) {
  const board = createTaskBoard({ maxRetries: 3 });
  const inputs = tasks.map((t) => ({
    id: taskItemId(t.id),
    description: `Task ${t.id}`,
    dependencies: (t.deps ?? []).map(taskItemId),
  }));
  const result = board.addAll(inputs);
  if (!result.ok) throw new Error(`Board setup failed: ${result.error.message}`);
  return result.value;
}

function noopReconciler(): TaskReconciler {
  return {
    check: async () => [],
  };
}

function actionReconciler(actions: readonly TaskReconcileAction[]): TaskReconciler {
  return {
    check: async () => actions,
  };
}

describe("createReconcilerHook", () => {
  describe("shouldCheck", () => {
    test("returns true on interval boundary", () => {
      const hook = createReconcilerHook({
        reconciler: noopReconciler(),
        intervalTurns: 3,
      });
      expect(hook.shouldCheck(0)).toBe(true);
      expect(hook.shouldCheck(1)).toBe(false);
      expect(hook.shouldCheck(2)).toBe(false);
      expect(hook.shouldCheck(3)).toBe(true);
      expect(hook.shouldCheck(6)).toBe(true);
    });

    test("defaults to intervalTurns = 5", () => {
      const hook = createReconcilerHook({
        reconciler: noopReconciler(),
      });
      expect(hook.shouldCheck(0)).toBe(true);
      expect(hook.shouldCheck(4)).toBe(false);
      expect(hook.shouldCheck(5)).toBe(true);
      expect(hook.shouldCheck(10)).toBe(true);
    });
  });

  describe("reconcile", () => {
    test("no-ops when reconciler returns empty array", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: noopReconciler(),
      });

      const result = await hook.reconcile(board);
      expect(result.all()).toHaveLength(1);
      expect(result.get(taskItemId("a"))?.description).toBe("Task a");
    });

    test("cancel action fails the task with reason", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          { kind: "cancel", taskId: taskItemId("a"), reason: "no longer needed" },
        ]),
      });

      const result = await hook.reconcile(board);
      const item = result.get(taskItemId("a"));
      expect(item?.status).toBe("failed");
      expect(item?.error?.message).toContain("no longer needed");
    });

    test("update action changes task description", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          {
            kind: "update",
            taskId: taskItemId("a"),
            description: "Updated description",
          },
        ]),
      });

      const result = await hook.reconcile(board);
      expect(result.get(taskItemId("a"))?.description).toBe("Updated description");
    });

    test("add action inserts new task", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          {
            kind: "add",
            task: {
              id: taskItemId("b"),
              description: "New task B",
              dependencies: [],
            },
          },
        ]),
      });

      const result = await hook.reconcile(board);
      expect(result.size()).toBe(2);
      expect(result.get(taskItemId("b"))?.description).toBe("New task B");
    });

    test("applies multiple actions in order", async () => {
      const board = setupBoard([{ id: "a" }, { id: "b" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          {
            kind: "update",
            taskId: taskItemId("a"),
            description: "Updated A",
          },
          {
            kind: "cancel",
            taskId: taskItemId("b"),
            reason: "obsolete",
          },
          {
            kind: "add",
            task: {
              id: taskItemId("c"),
              description: "New C",
              dependencies: [],
            },
          },
        ]),
      });

      const result = await hook.reconcile(board);
      expect(result.get(taskItemId("a"))?.description).toBe("Updated A");
      expect(result.get(taskItemId("b"))?.status).toBe("failed");
      expect(result.size()).toBe(3);
      expect(result.get(taskItemId("c"))?.description).toBe("New C");
    });

    test("reconciler throw proceeds without changes", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: {
          check: async () => {
            throw new Error("reconciler crashed");
          },
        },
      });

      const result = await hook.reconcile(board);
      expect(result.all()).toHaveLength(1);
      expect(result.get(taskItemId("a"))?.description).toBe("Task a");
    });

    test("reconciler timeout proceeds without changes", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: {
          check: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return [
              {
                kind: "update" as const,
                taskId: taskItemId("a"),
                description: "Should not apply",
              },
            ];
          },
        },
        timeoutMs: 50,
      });

      const result = await hook.reconcile(board);
      // Should return original board since reconciler timed out
      expect(result.get(taskItemId("a"))?.description).toBe("Task a");
    });

    test("skips cancel for non-existent task", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          {
            kind: "cancel",
            taskId: taskItemId("nonexistent"),
            reason: "ghost",
          },
        ]),
      });

      // Should not throw, just skip
      const result = await hook.reconcile(board);
      expect(result.all()).toHaveLength(1);
    });

    test("skips update for non-existent task", async () => {
      const board = setupBoard([{ id: "a" }]);
      const hook = createReconcilerHook({
        reconciler: actionReconciler([
          {
            kind: "update",
            taskId: taskItemId("nonexistent"),
            description: "ghost update",
          },
        ]),
      });

      const result = await hook.reconcile(board);
      expect(result.all()).toHaveLength(1);
    });
  });
});
