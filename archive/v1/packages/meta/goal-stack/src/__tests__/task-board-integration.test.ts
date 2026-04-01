import { describe, expect, test } from "bun:test";
import type { TaskBoardSnapshot, TaskItem, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import { createTaskAwareDrifting, createTaskBoardSource } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskItem(
  overrides: Partial<TaskItem> & {
    readonly id: TaskItemId;
    readonly description: string;
  },
): TaskItem {
  return {
    dependencies: [],
    priority: 1,
    maxRetries: 3,
    retries: 0,
    status: "pending",
    ...overrides,
  };
}

function makeSnapshot(items: readonly TaskItem[]): TaskBoardSnapshot {
  return { items, results: [] };
}

function makeTextMessage(text: string): InboundMessage {
  return {
    senderId: "user",
    content: [{ kind: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function makeTurnContext(messages: readonly InboundMessage[]): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "test-session" as unknown as import("@koi/core/ecs").SessionId,
      runId: "test-run" as unknown as import("@koi/core/ecs").RunId,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-0" as unknown as import("@koi/core/ecs").TurnId,
    messages,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// createTaskBoardSource
// ---------------------------------------------------------------------------

describe("createTaskBoardSource", () => {
  test("empty board returns empty string array", () => {
    const source = createTaskBoardSource(() => makeSnapshot([]));
    if (source.kind !== "tasks") throw new Error("Expected tasks kind");
    const result = source.provider(makeTurnContext([]));
    expect(result).toEqual([]);
  });

  test("filters to pending and assigned by default", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "pending",
      }),
      makeTaskItem({
        id: taskItemId("2"),
        description: "Deploy app",
        status: "completed",
      }),
      makeTaskItem({
        id: taskItemId("3"),
        description: "Fix bug",
        status: "assigned",
      }),
      makeTaskItem({
        id: taskItemId("4"),
        description: "Clean up",
        status: "failed",
      }),
    ];
    const source = createTaskBoardSource(() => makeSnapshot(items));
    if (source.kind !== "tasks") throw new Error("Expected tasks kind");
    const result = source.provider(makeTurnContext([]));
    expect(result).toHaveLength(2);
    expect(result).toContain("[pending] Write tests");
    expect(result).toContain("[assigned] Fix bug");
  });

  test("respects custom status filter", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "pending",
      }),
      makeTaskItem({
        id: taskItemId("2"),
        description: "Deploy app",
        status: "completed",
      }),
    ];
    const source = createTaskBoardSource(() => makeSnapshot(items), {
      statusFilter: ["completed"],
    });
    if (source.kind !== "tasks") throw new Error("Expected tasks kind");
    const result = source.provider(makeTurnContext([]));
    expect(result).toEqual(["[completed] Deploy app"]);
  });

  test("includes status prefix by default", async () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "pending",
      }),
    ];
    const source = createTaskBoardSource(() => makeSnapshot(items));
    if (source.kind !== "tasks") throw new Error("Expected tasks kind");
    const result = await source.provider(makeTurnContext([]));
    expect(result[0]).toMatch(/^\[pending\] /);
  });

  test("includes priority when configured", async () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "pending",
        priority: 3,
      }),
    ];
    const source = createTaskBoardSource(() => makeSnapshot(items), {
      includePriority: true,
    });
    if (source.kind !== "tasks") throw new Error("Expected tasks kind");
    const result = await source.provider(makeTurnContext([]));
    expect(result[0]).toBe("[pending] [P3] Write tests");
  });
});

// ---------------------------------------------------------------------------
// createTaskAwareDrifting
// ---------------------------------------------------------------------------

describe("createTaskAwareDrifting", () => {
  test("returns false when no pending tasks", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "completed",
      }),
    ];
    const isDrifting = createTaskAwareDrifting(() => makeSnapshot(items));
    const ctx = makeTurnContext([makeTextMessage("talking about something else")]);
    expect(isDrifting(ctx)).toBe(false);
  });

  test("returns false when pending task keywords appear in recent messages", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Implement authentication flow",
        status: "pending",
      }),
    ];
    const isDrifting = createTaskAwareDrifting(() => makeSnapshot(items));
    const ctx = makeTurnContext([makeTextMessage("Working on the authentication module now")]);
    expect(isDrifting(ctx)).toBe(false);
  });

  test("returns true when no keyword overlap with recent messages", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Implement authentication flow",
        status: "pending",
      }),
    ];
    const isDrifting = createTaskAwareDrifting(() => makeSnapshot(items));
    const ctx = makeTurnContext([makeTextMessage("Let me check the weather today")]);
    expect(isDrifting(ctx)).toBe(true);
  });

  test("returns false for empty board", () => {
    const isDrifting = createTaskAwareDrifting(() => makeSnapshot([]));
    const ctx = makeTurnContext([makeTextMessage("anything")]);
    expect(isDrifting(ctx)).toBe(false);
  });

  test("returns false when all tasks are completed", () => {
    const items = [
      makeTaskItem({
        id: taskItemId("1"),
        description: "Write tests",
        status: "completed",
      }),
      makeTaskItem({
        id: taskItemId("2"),
        description: "Deploy app",
        status: "completed",
      }),
    ];
    const isDrifting = createTaskAwareDrifting(() => makeSnapshot(items));
    const ctx = makeTurnContext([makeTextMessage("random unrelated text")]);
    expect(isDrifting(ctx)).toBe(false);
  });
});
