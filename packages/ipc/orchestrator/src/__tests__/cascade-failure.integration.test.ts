/**
 * Integration test: cascade failure — non-retryable failure blocks dependents.
 *
 * Tasks: A, B→A, C→A, D→[B,C]
 */

import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createAssignWorkerExecutor } from "../assign-worker-tool.js";
import { createTaskBoard } from "../board.js";
import type { BoardHolder } from "../orchestrate-tool.js";
import { executeOrchestrate } from "../orchestrate-tool.js";
import type { OrchestratorConfig } from "../types.js";

function createHolder(): BoardHolder {
  // let justified: mutable board reference
  let board: TaskBoard = createTaskBoard({ maxRetries: 3 });
  return {
    getBoard: () => board,
    setBoard: (b: TaskBoard) => {
      board = b;
    },
  };
}

describe("cascade failure integration", () => {
  test("non-retryable failure on A blocks B, C, and D", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const holder = createHolder();
    const signal = new AbortController().signal;

    const config: OrchestratorConfig = {
      spawn: async (req) => {
        if (req.taskId === taskItemId("a")) {
          return {
            ok: false,
            error: { code: "VALIDATION", message: "fatal error", retryable: false },
          };
        }
        return { ok: true, output: `result-${req.taskId}` };
      },
    };

    // Add tasks
    executeOrchestrate(
      {
        action: "add",
        tasks: [
          { id: "a", description: "Task A" },
          { id: "b", description: "Task B", dependencies: ["a"] },
          { id: "c", description: "Task C", dependencies: ["a"] },
          { id: "d", description: "Task D", dependencies: ["b", "c"] },
        ],
      },
      holder,
    );

    // Assign A — fails permanently
    const r = await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(r).toContain("failed permanently");

    // A is failed
    expect(holder.getBoard().failed()).toHaveLength(1);
    expect(holder.getBoard().failed()[0]?.id).toBe(taskItemId("a"));

    // B and C are blocked (their dep A is failed, not completed)
    expect(holder.getBoard().blocked()).toHaveLength(3);
    const blockedIds = holder
      .getBoard()
      .blocked()
      .map((t) => t.id);
    expect(blockedIds).toContain(taskItemId("b"));
    expect(blockedIds).toContain(taskItemId("c"));
    expect(blockedIds).toContain(taskItemId("d"));

    // Nothing is ready
    expect(holder.getBoard().ready()).toHaveLength(0);

    // dependentsOf(A) returns B and C
    const dependents = holder.getBoard().dependentsOf(taskItemId("a"));
    const depIds = dependents.map((t) => t.id);
    expect(depIds).toContain(taskItemId("b"));
    expect(depIds).toContain(taskItemId("c"));
    expect(depIds).not.toContain(taskItemId("d"));

    // Summary shows the failure
    const summary = executeOrchestrate({ action: "query", view: "summary" }, holder);
    expect(summary).toContain("Failed: 1");
    expect(summary).toContain("Blocked: 3");
  });
});
