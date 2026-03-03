import { describe, expect, test } from "bun:test";
import type { TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskTools } from "./task-tools.js";

function createBoard(overrides?: Partial<TaskBoardSnapshot>): TaskBoardSnapshot {
  return {
    items: [
      {
        id: taskItemId("t1"),
        description: "First task",
        dependencies: [],
        priority: 0,
        maxRetries: 3,
        retries: 0,
        status: "pending",
      },
      {
        id: taskItemId("t2"),
        description: "Second task",
        dependencies: [taskItemId("t1")],
        priority: 0,
        maxRetries: 3,
        retries: 0,
        status: "pending",
      },
    ],
    results: [],
    ...overrides,
  };
}

describe("createTaskTools", () => {
  test("returns three tools", () => {
    const tools = createTaskTools({
      getTaskBoard: () => createBoard(),
      completeTask: async () => {},
      updateTask: async () => {},
    });
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.descriptor.name)).toEqual([
      "task_complete",
      "task_update",
      "task_status",
    ]);
  });

  test("task_complete calls completeTask and reports remaining", async () => {
    let completedId: TaskItemId | undefined;
    let completedOutput: string | undefined;

    // After completion, board has 1 remaining
    const boardAfterComplete = createBoard({
      items: [
        {
          id: taskItemId("t1"),
          description: "First task",
          dependencies: [],
          priority: 0,
          maxRetries: 3,
          retries: 0,
          status: "completed",
        },
        {
          id: taskItemId("t2"),
          description: "Second task",
          dependencies: [taskItemId("t1")],
          priority: 0,
          maxRetries: 3,
          retries: 0,
          status: "pending",
        },
      ],
    });

    const tools = createTaskTools({
      getTaskBoard: () => boardAfterComplete,
      completeTask: async (tid, output) => {
        completedId = tid;
        completedOutput = output;
      },
      updateTask: async () => {},
    });

    const taskCompleteTool = tools[0];
    expect(taskCompleteTool).toBeDefined();
    const result = (await taskCompleteTool?.execute({
      task_id: "t1",
      output: "done!",
    })) as { remainingTasks: number };

    expect(completedId).toBe(taskItemId("t1"));
    expect(completedOutput).toBe("done!");
    expect(result.remainingTasks).toBe(1);
  });

  test("task_status returns board summary", async () => {
    const tools = createTaskTools({
      getTaskBoard: () => createBoard(),
      completeTask: async () => {},
      updateTask: async () => {},
    });

    const taskStatusTool = tools[2];
    expect(taskStatusTool).toBeDefined();
    const result = (await taskStatusTool?.execute({})) as {
      totalTasks: number;
      pending: number;
    };

    expect(result.totalTasks).toBe(2);
    expect(result.pending).toBe(2);
  });

  test("task_complete validates required inputs", async () => {
    const tools = createTaskTools({
      getTaskBoard: () => createBoard(),
      completeTask: async () => {},
      updateTask: async () => {},
    });

    const taskCompleteTool = tools[0];
    expect(taskCompleteTool).toBeDefined();
    const result = (await taskCompleteTool?.execute({})) as { error: string };
    expect(result.error).toContain("task_id and output are required");
  });
});
