/**
 * Integration test: happy path — full DAG execution with 5 tasks.
 *
 * Diamond: A (no deps), B→A, C→A, D→[B,C], E→D
 */

import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
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

describe("happy path integration", () => {
  test("executes 5-task diamond DAG to completion", async () => {
    resetWorkerCounter();
    const holder = createHolder();
    const signal = new AbortController().signal;

    const config: OrchestratorConfig = {
      spawn: async (req) => ({ ok: true, output: `result-${req.taskId}` }),
    };

    // Add all 5 tasks
    const addResult = executeOrchestrate(
      {
        action: "add",
        tasks: [
          { id: "a", description: "Task A" },
          { id: "b", description: "Task B", dependencies: ["a"] },
          { id: "c", description: "Task C", dependencies: ["a"] },
          { id: "d", description: "Task D", dependencies: ["b", "c"] },
          { id: "e", description: "Task E", dependencies: ["d"] },
        ],
      },
      holder,
    );
    expect(addResult).toContain("Added 5");

    // Query ready → only A
    const q1 = executeOrchestrate({ action: "query", view: "ready" }, holder);
    expect(q1).toContain("a:");
    expect(q1).not.toContain("b:");

    // Assign A
    await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(1);

    // Now B and C should be ready
    const q2 = executeOrchestrate({ action: "query", view: "ready" }, holder);
    expect(q2).toContain("b:");
    expect(q2).toContain("c:");

    // Assign B and C
    await executeAssignWorker({ task_id: "b" }, holder, config, signal);
    await executeAssignWorker({ task_id: "c" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(3);

    // D should be ready
    const q3 = executeOrchestrate({ action: "query", view: "ready" }, holder);
    expect(q3).toContain("d:");

    await executeAssignWorker({ task_id: "d" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(4);

    // E should be ready
    await executeAssignWorker({ task_id: "e" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(5);
    expect(holder.getBoard().ready()).toHaveLength(0);

    // Synthesize
    const synthesis = executeSynthesize({}, holder);
    expect(synthesis).toContain("5 task(s)");
    expect(synthesis).toContain("result-a");
    expect(synthesis).toContain("result-e");
  });
});
