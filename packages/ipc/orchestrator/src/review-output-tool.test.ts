import { describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import { executeReviewOutput } from "./review-output-tool.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

function createHolder(board?: TaskBoard): BoardHolder {
  // let justified: mutable board reference
  let b: TaskBoard = board ?? createTaskBoard();
  return {
    getBoard: () => b,
    setBoard: (nb: TaskBoard) => {
      b = nb;
    },
  };
}

function setupCompletedBoard(): BoardHolder {
  const board = createTaskBoard({ maxRetries: 3 });
  const r1 = board.add({ id: taskItemId("a"), description: "Task A" });
  if (!r1.ok) throw new Error("setup failed");
  const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
  if (!r2.ok) throw new Error("setup failed");
  const r3 = r2.value.complete(taskItemId("a"), {
    taskId: taskItemId("a"),
    output: "output",
    durationMs: 100,
  });
  if (!r3.ok) throw new Error("setup failed");
  return createHolder(r3.value);
}

describe("executeReviewOutput", () => {
  test("accept leaves task completed", () => {
    const holder = setupCompletedBoard();
    const result = executeReviewOutput({ task_id: "a", verdict: "accept" }, holder);
    expect(result).toContain("accepted");
    expect(holder.getBoard().get(taskItemId("a"))?.status).toBe("completed");
  });

  test("reject causes retry when retryable", () => {
    const holder = setupCompletedBoard();
    const result = executeReviewOutput(
      {
        task_id: "a",
        verdict: "reject",
        feedback: "wrong format",
      },
      holder,
    );
    expect(result).toContain("reject");
    // After reject on a completed task, board.fail is called
    // The task goes back to pending (retryable, retries remaining)
    const task = holder.getBoard().get(taskItemId("a"));
    expect(task?.status).toBe("pending");
  });

  test("revise causes retry with feedback", () => {
    const holder = setupCompletedBoard();
    const result = executeReviewOutput(
      {
        task_id: "a",
        verdict: "revise",
        feedback: "add more detail",
      },
      holder,
    );
    expect(result).toContain("revise");
    expect(result).toContain("add more detail");
  });

  test("returns error for non-existent task", () => {
    const holder = createHolder();
    const result = executeReviewOutput({ task_id: "nope", verdict: "accept" }, holder);
    expect(result).toContain("not found");
  });

  test("returns error for invalid input", () => {
    const holder = createHolder();
    const result = executeReviewOutput({}, holder);
    expect(result).toContain("task_id");
  });

  test("returns error for invalid verdict", () => {
    const holder = createHolder();
    const result = executeReviewOutput({ task_id: "a", verdict: "maybe" }, holder);
    expect(result).toContain("verdict");
  });
});
