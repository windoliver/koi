import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import { executeOrchestrate } from "./orchestrate-tool.js";

function createHolder(): BoardHolder {
  // let justified: mutable board reference
  let board: TaskBoard = createTaskBoard();
  return {
    getBoard: () => board,
    setBoard: (b: TaskBoard) => {
      board = b;
    },
  };
}

describe("executeOrchestrate", () => {
  describe("action: add", () => {
    test("adds valid tasks and returns success message", () => {
      const holder = createHolder();
      const result = executeOrchestrate(
        {
          action: "add",
          tasks: [
            { id: "a", description: "Task A" },
            { id: "b", description: "Task B", dependencies: ["a"] },
          ],
        },
        holder,
      );
      expect(result).toContain("Added 2 task(s)");
      expect(result).toContain("Ready: 1");
      expect(holder.getBoard().size()).toBe(2);
    });

    test("returns error for cycle", () => {
      const holder = createHolder();
      const result = executeOrchestrate(
        {
          action: "add",
          tasks: [
            { id: "a", description: "Task A", dependencies: ["b"] },
            { id: "b", description: "Task B", dependencies: ["a"] },
          ],
        },
        holder,
      );
      expect(result).toContain("Error");
      expect(holder.getBoard().size()).toBe(0);
    });
  });

  describe("action: query", () => {
    test("returns summary by default", () => {
      const holder = createHolder();
      executeOrchestrate(
        {
          action: "add",
          tasks: [{ id: "a", description: "Task A" }],
        },
        holder,
      );
      const result = executeOrchestrate({ action: "query" }, holder);
      expect(result).toContain("Total: 1");
      expect(result).toContain("Ready: 1");
    });

    test("returns ready tasks for view: ready", () => {
      const holder = createHolder();
      executeOrchestrate(
        {
          action: "add",
          tasks: [
            { id: "a", description: "Task A" },
            { id: "b", description: "Task B", dependencies: ["a"] },
          ],
        },
        holder,
      );
      const result = executeOrchestrate({ action: "query", view: "ready" }, holder);
      expect(result).toContain("a:");
      expect(result).not.toContain("b:");
    });

    test("returns (none) when nothing matches", () => {
      const holder = createHolder();
      const result = executeOrchestrate({ action: "query", view: "failed" }, holder);
      expect(result).toBe("(none)");
    });
  });

  describe("action: update", () => {
    test("applies patch and returns confirmation", () => {
      const holder = createHolder();
      executeOrchestrate(
        {
          action: "add",
          tasks: [{ id: "a", description: "Task A" }],
        },
        holder,
      );
      const result = executeOrchestrate(
        {
          action: "update",
          taskId: "a",
          patch: { priority: 5 },
        },
        holder,
      );
      expect(result).toContain("updated");
      expect(result).toContain("priority=5");
      expect(holder.getBoard().get("a" as import("@koi/core").TaskItemId)?.priority).toBe(5);
    });

    test("returns error for non-existent task", () => {
      const holder = createHolder();
      const result = executeOrchestrate(
        {
          action: "update",
          taskId: "nope",
          patch: {},
        },
        holder,
      );
      expect(result).toContain("not found");
    });
  });

  describe("action: query summary", () => {
    test("summary shows unreachable count and blocked-by info", () => {
      const holder = createHolder();
      // Add a → b chain, fail a, check summary
      executeOrchestrate(
        {
          action: "add",
          tasks: [
            { id: "a", description: "Task A" },
            { id: "b", description: "Task B", dependencies: ["a"] },
          ],
        },
        holder,
      );
      // Manually assign and fail task a
      const board = holder.getBoard();
      const r1 = board.assign(
        "a" as import("@koi/core").TaskItemId,
        "w1" as import("@koi/core").AgentId,
      );
      if (r1.ok) {
        const r2 = r1.value.fail("a" as import("@koi/core").TaskItemId, {
          code: "EXTERNAL",
          message: "crash",
          retryable: false,
        });
        if (r2.ok) holder.setBoard(r2.value);
      }
      const result = executeOrchestrate({ action: "query", view: "summary" }, holder);
      expect(result).toContain("Unreachable: 1");
      expect(result).toContain("b→blocked by a");
    });
  });

  describe("invalid input", () => {
    test("returns error for non-object input", () => {
      const holder = createHolder();
      const result = executeOrchestrate("bad", holder);
      expect(result).toContain("must be a non-null object");
    });

    test("returns error for missing action", () => {
      const holder = createHolder();
      const result = executeOrchestrate({}, holder);
      expect(result).toContain("Invalid action");
    });

    test("returns error for unknown action", () => {
      const holder = createHolder();
      const result = executeOrchestrate({ action: "delete" }, holder);
      expect(result).toContain("Invalid action");
    });
  });
});
