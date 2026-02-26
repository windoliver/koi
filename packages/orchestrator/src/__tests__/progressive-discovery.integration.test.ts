/**
 * Integration test: progressive discovery — tasks added during execution.
 *
 * Start with A, B. After A completes, add C→A. After B and C complete, add D→[B,C].
 */

import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { executeAssignWorker, resetWorkerCounter } from "../assign-worker-tool.js";
import { createTaskBoard } from "../board.js";
import type { BoardHolder } from "../orchestrate-tool.js";
import { executeOrchestrate } from "../orchestrate-tool.js";
import { executeSynthesize } from "../synthesize-tool.js";
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

describe("progressive discovery integration", () => {
  test("tasks added mid-execution integrate correctly", async () => {
    resetWorkerCounter();
    const holder = createHolder();
    const signal = new AbortController().signal;

    const config: OrchestratorConfig = {
      spawn: async (req) => ({ ok: true, output: `result-${req.taskId}` }),
    };

    // Start with A and B
    executeOrchestrate(
      {
        action: "add",
        tasks: [
          { id: "a", description: "Task A" },
          { id: "b", description: "Task B" },
        ],
      },
      holder,
    );
    expect(holder.getBoard().ready()).toHaveLength(2);

    // Complete A
    await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(1);

    // Discover C that depends on (already completed) A — should be immediately ready
    executeOrchestrate(
      {
        action: "add",
        tasks: [{ id: "c", description: "Task C (discovered)", dependencies: ["a"] }],
      },
      holder,
    );
    expect(holder.getBoard().size()).toBe(3);
    const readyIds = holder
      .getBoard()
      .ready()
      .map((t) => t.id);
    expect(readyIds).toContain(taskItemId("b"));
    expect(readyIds).toContain(taskItemId("c"));

    // Complete C
    await executeAssignWorker({ task_id: "c" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(2);

    // Complete B
    await executeAssignWorker({ task_id: "b" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(3);

    // Discover D that depends on B and C
    executeOrchestrate(
      {
        action: "add",
        tasks: [{ id: "d", description: "Task D (final)", dependencies: ["b", "c"] }],
      },
      holder,
    );
    expect(holder.getBoard().ready()).toHaveLength(1);
    expect(holder.getBoard().ready()[0]?.id).toBe(taskItemId("d"));

    // Complete D
    await executeAssignWorker({ task_id: "d" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(4);
    expect(holder.getBoard().ready()).toHaveLength(0);

    // Synthesize
    const synthesis = executeSynthesize({}, holder);
    expect(synthesis).toContain("4 task(s)");
    expect(synthesis).toContain("result-a");
    expect(synthesis).toContain("result-d");
  });
});
