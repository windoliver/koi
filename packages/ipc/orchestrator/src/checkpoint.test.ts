import { describe, expect, test } from "bun:test";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";
import { deserializeBoard, serializeBoard } from "./checkpoint.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

describe("checkpoint", () => {
  test("round-trip serialize → deserialize preserves all state", () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const r1 = board.addAll([
      { id: taskItemId("a"), description: "Task A" },
      { id: taskItemId("b"), description: "Task B", dependencies: [taskItemId("a")] },
    ]);
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), agentId("w1"));
    if (!r2.ok) throw new Error("setup failed");
    const r3 = r2.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "output-a",
      durationMs: 150,
    });
    if (!r3.ok) throw new Error("setup failed");

    const snapshot = serializeBoard(r3.value);
    const restored = deserializeBoard(snapshot, { maxRetries: 3 });

    expect(restored.size()).toBe(2);
    expect(restored.completed()).toHaveLength(1);
    expect(restored.completed()[0]?.output).toBe("output-a");
    expect(restored.get(taskItemId("a"))?.status).toBe("completed");
    expect(restored.get(taskItemId("b"))?.status).toBe("pending");
    // b should now be ready since a is completed
    expect(restored.ready()).toHaveLength(1);
    expect(restored.ready()[0]?.id).toBe(taskItemId("b"));
  });

  test("empty board round-trips correctly", () => {
    const board = createTaskBoard();
    const snapshot = serializeBoard(board);
    const restored = deserializeBoard(snapshot);
    expect(restored.size()).toBe(0);
    expect(restored.all()).toEqual([]);
    expect(restored.completed()).toEqual([]);
  });

  test("content-hash dedup: same board produces same snapshot", () => {
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");

    const snap1 = serializeBoard(r.value);
    const snap2 = serializeBoard(r.value);
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
  });
});
