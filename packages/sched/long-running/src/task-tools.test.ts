import { describe, expect, test } from "bun:test";
import type { TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { TaskToolsConfig } from "./task-tools.js";
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

function completedBoard(): TaskBoardSnapshot {
  return {
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
        status: "completed",
      },
    ],
    results: [
      { taskId: taskItemId("t1"), output: "output-1", durationMs: 100 },
      { taskId: taskItemId("t2"), output: "output-2", durationMs: 200 },
    ],
  };
}

function defaultConfig(board?: TaskBoardSnapshot): TaskToolsConfig {
  const b = board ?? createBoard();
  return {
    getTaskBoard: () => b,
    completeTask: async () => {},
    updateTask: async () => {},
  };
}

describe("createTaskTools", () => {
  test("returns five tools", () => {
    const tools = createTaskTools(defaultConfig());
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.descriptor.name)).toEqual([
      "task_complete",
      "task_update",
      "task_status",
      "task_review",
      "task_synthesize",
    ]);
  });

  test("task_complete calls completeTask and reports remaining", async () => {
    let completedId: TaskItemId | undefined;
    let completedOutput: string | undefined;

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

    const result = (await tools[0]?.execute({
      task_id: "t1",
      output: "done!",
    })) as { remainingTasks: number };

    expect(completedId).toBe(taskItemId("t1"));
    expect(completedOutput).toBe("done!");
    expect(result.remainingTasks).toBe(1);
  });

  test("task_status returns board summary", async () => {
    const tools = createTaskTools(defaultConfig());
    const result = (await tools[2]?.execute({})) as {
      totalTasks: number;
      pending: number;
    };
    expect(result.totalTasks).toBe(2);
    expect(result.pending).toBe(2);
  });

  test("task_complete validates required inputs", async () => {
    const tools = createTaskTools(defaultConfig());
    const result = (await tools[0]?.execute({})) as { error: string };
    expect(result.error).toContain("task_id and output are required");
  });
});

describe("task_review", () => {
  test("accept leaves task unchanged", async () => {
    const tools = createTaskTools(defaultConfig(completedBoard()));
    const result = (await tools[3]?.execute({
      task_id: "t1",
      verdict: "accept",
    })) as { message: string };
    expect(result.message).toContain("accepted");
  });

  test("reject triggers failTask callback", async () => {
    let failedId: TaskItemId | undefined;
    const afterReject: TaskBoardSnapshot = {
      items: [
        {
          id: taskItemId("t1"),
          description: "First task",
          dependencies: [],
          priority: 0,
          maxRetries: 3,
          retries: 1,
          status: "pending",
        },
      ],
      results: [],
    };

    const tools = createTaskTools({
      getTaskBoard: () => completedBoard(),
      completeTask: async () => {},
      updateTask: async () => {},
      failTask: async (tid) => {
        failedId = tid;
        return afterReject;
      },
    });

    const result = (await tools[3]?.execute({
      task_id: "t1",
      verdict: "reject",
      feedback: "wrong format",
    })) as { message: string };

    expect(failedId).toBe(taskItemId("t1"));
    expect(result.message).toContain("reject");
    expect(result.message).toContain("retry");
  });

  test("returns error for non-existent task", async () => {
    const tools = createTaskTools(defaultConfig(completedBoard()));
    const result = (await tools[3]?.execute({
      task_id: "nonexistent",
      verdict: "accept",
    })) as { message: string };
    expect(result.message).toContain("not found");
  });

  test("returns error for invalid verdict", async () => {
    const tools = createTaskTools(defaultConfig(completedBoard()));
    const result = (await tools[3]?.execute({
      task_id: "t1",
      verdict: "maybe",
    })) as { message: string };
    expect(result.message).toContain("verdict");
  });

  test("reject without failTask returns not supported", async () => {
    const tools = createTaskTools(defaultConfig(completedBoard()));
    const result = (await tools[3]?.execute({
      task_id: "t1",
      verdict: "reject",
    })) as { message: string };
    expect(result.message).toContain("not supported");
  });
});

describe("task_synthesize", () => {
  test("returns message when no completed tasks", async () => {
    const tools = createTaskTools(defaultConfig());
    const result = (await tools[4]?.execute({})) as { message: string };
    expect(result.message).toContain("No completed tasks");
  });

  test("aggregates results in dependency order", async () => {
    const tools = createTaskTools(defaultConfig(completedBoard()));
    const result = (await tools[4]?.execute({})) as { message: string };
    expect(result.message).toContain("2 task(s)");
    const idx1 = result.message.indexOf("output-1");
    const idx2 = result.message.indexOf("output-2");
    expect(idx1).toBeLessThan(idx2);
  });

  test("truncates long outputs", async () => {
    const board: TaskBoardSnapshot = {
      items: [
        {
          id: taskItemId("t1"),
          description: "Long",
          dependencies: [],
          priority: 0,
          maxRetries: 3,
          retries: 0,
          status: "completed",
        },
      ],
      results: [{ taskId: taskItemId("t1"), output: "x".repeat(200), durationMs: 100 }],
    };

    const tools = createTaskTools({
      ...defaultConfig(board),
      maxOutputPerTask: 50,
    });

    const result = (await tools[4]?.execute({})) as { message: string };
    expect(result.message).toContain("truncated");
  });

  test("renders artifacts section", async () => {
    const board: TaskBoardSnapshot = {
      items: [
        {
          id: taskItemId("t1"),
          description: "With artifacts",
          dependencies: [],
          priority: 0,
          maxRetries: 3,
          retries: 0,
          status: "completed",
        },
      ],
      results: [
        {
          taskId: taskItemId("t1"),
          output: "done",
          durationMs: 100,
          artifacts: [{ id: "art-1", kind: "file", uri: "file:///report.json" }],
        },
      ],
    };
    const tools = createTaskTools(defaultConfig(board));
    const result = (await tools[4]?.execute({})) as { message: string };
    expect(result.message).toContain("### Artifacts");
    expect(result.message).toContain("file: file:///report.json");
  });
});
