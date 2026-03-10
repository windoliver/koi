import { describe, expect, test } from "bun:test";
import type { TaskBoardAdminClientLike, TaskItemLike } from "./task-board-admin-adapter.js";
import { createTaskBoardAdminAdapter } from "./task-board-admin-adapter.js";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function createMockClient(
  items: readonly TaskItemLike[] = [],
  results: readonly { readonly taskId: string; readonly output: string }[] = [],
): TaskBoardAdminClientLike {
  return {
    all: () => items,
    completed: () => results,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTaskBoardAdminAdapter", () => {
  test("returns empty snapshot for empty board", () => {
    const adapter = createTaskBoardAdminAdapter(createMockClient());
    const snapshot = adapter.views.getSnapshot();

    expect(snapshot.nodes).toHaveLength(0);
    expect(snapshot.edges).toHaveLength(0);
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });

  test("maps task items to nodes with correct status", () => {
    const items: TaskItemLike[] = [
      { id: "t1", description: "Task 1", status: "pending", dependencies: [] },
      {
        id: "t2",
        description: "Task 2",
        status: "assigned",
        assignedTo: "agent:worker",
        dependencies: ["t1"],
      },
      { id: "t3", description: "Task 3", status: "completed", dependencies: ["t1"] },
      {
        id: "t4",
        description: "Task 4",
        status: "failed",
        dependencies: [],
        error: { message: "boom" },
      },
    ];
    const results = [{ taskId: "t3", output: "done" }];

    const adapter = createTaskBoardAdminAdapter(createMockClient(items, results));
    const snapshot = adapter.views.getSnapshot();

    expect(snapshot.nodes).toHaveLength(4);
    expect(snapshot.nodes[0]?.status).toBe("pending");
    expect(snapshot.nodes[1]?.status).toBe("running"); // assigned → running
    expect(snapshot.nodes[1]?.assignedTo).toBe("agent:worker");
    expect(snapshot.nodes[2]?.status).toBe("completed");
    expect(snapshot.nodes[2]?.result).toBe("done");
    expect(snapshot.nodes[3]?.error).toBe("boom");
  });

  test("builds edges from dependencies", () => {
    const items: TaskItemLike[] = [
      { id: "t1", description: "Root", status: "completed", dependencies: [] },
      { id: "t2", description: "Child A", status: "pending", dependencies: ["t1"] },
      { id: "t3", description: "Child B", status: "pending", dependencies: ["t1", "t2"] },
    ];

    const adapter = createTaskBoardAdminAdapter(createMockClient(items));
    const snapshot = adapter.views.getSnapshot();

    expect(snapshot.edges).toHaveLength(3);
    expect(snapshot.edges).toContainEqual({ from: "t1", to: "t2" });
    expect(snapshot.edges).toContainEqual({ from: "t1", to: "t3" });
    expect(snapshot.edges).toContainEqual({ from: "t2", to: "t3" });
  });

  test("uses labels from task descriptions", () => {
    const items: TaskItemLike[] = [
      { id: "t1", description: "Research AI papers", status: "pending", dependencies: [] },
    ];

    const adapter = createTaskBoardAdminAdapter(createMockClient(items));
    const snapshot = adapter.views.getSnapshot();

    expect(snapshot.nodes[0]?.label).toBe("Research AI papers");
  });
});
