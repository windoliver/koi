/**
 * Integration test: retry — task fails then succeeds on retry.
 *
 * Chain: A, B→A, C→B
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

describe("retry integration", () => {
  test("retries failed task and proceeds normally after success", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const holder = createHolder();
    const signal = new AbortController().signal;

    // let justified: tracking spawn call count for task "a"
    let aCallCount = 0;

    const config: OrchestratorConfig = {
      spawn: async (req) => {
        if (req.taskId === taskItemId("a")) {
          aCallCount += 1;
          if (aCallCount === 1) {
            return {
              ok: false,
              error: { code: "EXTERNAL", message: "network error", retryable: true },
            };
          }
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
          { id: "c", description: "Task C", dependencies: ["b"] },
        ],
      },
      holder,
    );

    // First attempt at A — fails
    const r1 = await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(r1).toContain("retrying");
    expect(holder.getBoard().get(taskItemId("a"))?.status).toBe("pending");
    expect(holder.getBoard().get(taskItemId("a"))?.retries).toBe(1);

    // A is still ready (retry)
    expect(holder.getBoard().ready()).toHaveLength(1);

    // Second attempt — succeeds
    const r2 = await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(r2).toContain("completed");

    // B is now ready
    await executeAssignWorker({ task_id: "b" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(2);

    // C is now ready
    await executeAssignWorker({ task_id: "c" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(3);
    expect(holder.getBoard().ready()).toHaveLength(0);
    expect(holder.getBoard().failed()).toHaveLength(0);
  });
});
