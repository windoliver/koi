/**
 * Integration test: upstream propagation — downstream worker receives
 * upstream task results through DAG edges.
 *
 * Pipeline: A (no deps) → B (depends on A)
 */

import { describe, expect, test } from "bun:test";
import type { TaskBoard, TaskResult } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createAssignWorkerExecutor } from "../assign-worker-tool.js";
import { createTaskBoard } from "../board.js";
import type { BoardHolder } from "../orchestrate-tool.js";
import { executeOrchestrate } from "../orchestrate-tool.js";
import type { OrchestratorConfig, SpawnWorkerRequest } from "../types.js";

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

describe("upstream propagation integration", () => {
  test("downstream worker receives upstream task results through DAG edge", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const holder = createHolder();
    const signal = new AbortController().signal;

    // Capture spawn requests to inspect upstream context
    const captured: SpawnWorkerRequest[] = [];

    const config: OrchestratorConfig = {
      spawn: async (req) => {
        captured.push(req);
        return {
          ok: true,
          output: `result-${req.taskId}`,
          artifacts:
            req.taskId === taskItemId("a")
              ? [{ id: "art-1", kind: "analysis", uri: "file:///analysis.json" }]
              : undefined,
          warnings: req.taskId === taskItemId("a") ? ["check coverage"] : undefined,
        };
      },
    };

    // Add pipeline: A → B
    executeOrchestrate(
      {
        action: "add",
        tasks: [
          { id: "a", description: "Analyze codebase" },
          { id: "b", description: "Generate report", dependencies: ["a"] },
        ],
      },
      holder,
    );

    // Complete A
    await executeAssignWorker({ task_id: "a" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(1);

    // Complete B — should receive A's results as upstream context
    await executeAssignWorker({ task_id: "b" }, holder, config, signal);
    expect(holder.getBoard().completed()).toHaveLength(2);

    // Verify B received upstream results from A
    const bRequest = captured[1];
    expect(bRequest).toBeDefined();
    expect(bRequest?.upstreamResults).toBeDefined();
    expect(bRequest?.upstreamResults).toHaveLength(1);

    const upstreamA = bRequest?.upstreamResults?.[0] as TaskResult | undefined;
    expect(upstreamA?.taskId).toBe(taskItemId("a"));
    expect(upstreamA?.output).toBe("result-a");
    expect(upstreamA?.artifacts).toHaveLength(1);
    expect(upstreamA?.artifacts?.[0]?.kind).toBe("analysis");
    expect(upstreamA?.warnings).toEqual(["check coverage"]);

    // Verify A had no upstream results (no deps)
    const aRequest = captured[0];
    expect(aRequest?.upstreamResults).toBeUndefined();
  });
});
