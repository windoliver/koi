import { describe, expect, test } from "bun:test";
import type { AgentId, TaskResult } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";
import {
  deserializeBoard,
  formatUpstreamContext,
  serializeBoard,
  snapshotToItemsMap,
} from "./helpers.js";

function agentId(id: string): AgentId {
  return id as AgentId;
}

describe("snapshotToItemsMap", () => {
  test("converts board items to map keyed by id", () => {
    const board = createTaskBoard();
    const r = board.addAll([
      { id: taskItemId("a"), description: "A" },
      { id: taskItemId("b"), description: "B" },
    ]);
    if (!r.ok) throw new Error("setup failed");
    const map = snapshotToItemsMap(r.value);
    expect(map.size).toBe(2);
    expect(map.get(taskItemId("a"))?.description).toBe("A");
    expect(map.get(taskItemId("b"))?.description).toBe("B");
  });
});

describe("formatUpstreamContext", () => {
  test("returns empty string for no results", () => {
    expect(formatUpstreamContext([], 1000)).toBe("");
  });

  test("formats single result", () => {
    const results: TaskResult[] = [{ taskId: taskItemId("a"), output: "done", durationMs: 100 }];
    const ctx = formatUpstreamContext(results, 1000);
    expect(ctx).toContain("[Upstream: a]");
    expect(ctx).toContain("Output: done");
  });

  test("truncates long output", () => {
    const results: TaskResult[] = [
      { taskId: taskItemId("a"), output: "x".repeat(200), durationMs: 100 },
    ];
    const ctx = formatUpstreamContext(results, 50);
    expect(ctx).toContain("truncated");
  });

  test("includes artifacts and warnings", () => {
    const results: TaskResult[] = [
      {
        taskId: taskItemId("a"),
        output: "done",
        durationMs: 100,
        artifacts: [{ id: "art1", kind: "file", uri: "file:///out.json" }],
        warnings: ["low memory"],
      },
    ];
    const ctx = formatUpstreamContext(results, 1000);
    expect(ctx).toContain("file:file:///out.json");
    expect(ctx).toContain("low memory");
  });
});

describe("serializeBoard / deserializeBoard", () => {
  test("round-trip preserves state", () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const r1 = board.add({ id: taskItemId("a"), description: "Task A" });
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

    expect(restored.size()).toBe(1);
    expect(restored.completed()).toHaveLength(1);
    expect(restored.completed()[0]?.output).toBe("output-a");
  });

  test("empty board round-trips", () => {
    const board = createTaskBoard();
    const snapshot = serializeBoard(board);
    const restored = deserializeBoard(snapshot);
    expect(restored.size()).toBe(0);
  });
});
