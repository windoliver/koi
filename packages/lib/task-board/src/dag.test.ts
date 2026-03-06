import { describe, expect, test } from "bun:test";
import type { TaskItem, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { detectCycle, topologicalSort } from "./dag.js";

function item(id: string, deps: readonly string[] = []): TaskItem {
  return {
    id: taskItemId(id),
    description: `Task ${id}`,
    dependencies: deps.map(taskItemId),
    priority: 0,
    maxRetries: 3,
    retries: 0,
    status: "pending",
  };
}

function toMap(items: readonly TaskItem[]): ReadonlyMap<TaskItemId, TaskItem> {
  return new Map(items.map((i) => [i.id, i]));
}

describe("detectCycle", () => {
  test("returns undefined for empty graph", () => {
    const items = toMap([]);
    const result = detectCycle(items, [], taskItemId("a"));
    expect(result).toBeUndefined();
  });

  test("returns undefined for linear chain A→B→C", () => {
    const items = toMap([item("a"), item("b", ["a"]), item("c", ["b"])]);
    const result = detectCycle(items, [taskItemId("c")], taskItemId("d"));
    expect(result).toBeUndefined();
  });

  test("detects self-dependency", () => {
    const items = toMap([item("a")]);
    const result = detectCycle(items, [taskItemId("a")], taskItemId("a"));
    expect(result).toBeDefined();
    expect(result).toContain(taskItemId("a"));
  });

  test("detects indirect cycle", () => {
    const items = toMap([item("b", ["a"]), item("c", ["b"]), item("d", ["c"])]);
    const result = detectCycle(items, [taskItemId("d")], taskItemId("a"));
    expect(result).toBeDefined();
  });

  test("returns undefined for diamond DAG (valid)", () => {
    const items = toMap([item("a"), item("b", ["a"]), item("c", ["a"]), item("d", ["b", "c"])]);
    const result = detectCycle(items, ["b", "c"].map(taskItemId), taskItemId("e"));
    expect(result).toBeUndefined();
  });
});

describe("topologicalSort", () => {
  test("returns empty array for empty graph", () => {
    const result = topologicalSort(toMap([]));
    expect(result).toEqual([]);
  });

  test("returns single item", () => {
    const result = topologicalSort(toMap([item("a")]));
    expect(result).toEqual([taskItemId("a")]);
  });

  test("returns linear chain in order", () => {
    const items = toMap([item("c", ["b"]), item("b", ["a"]), item("a")]);
    const result = topologicalSort(items);
    const aIdx = result.indexOf(taskItemId("a"));
    const bIdx = result.indexOf(taskItemId("b"));
    const cIdx = result.indexOf(taskItemId("c"));
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  test("respects diamond dependencies", () => {
    const items = toMap([item("a"), item("b", ["a"]), item("c", ["a"]), item("d", ["b", "c"])]);
    const result = topologicalSort(items);
    const aIdx = result.indexOf(taskItemId("a"));
    const bIdx = result.indexOf(taskItemId("b"));
    const cIdx = result.indexOf(taskItemId("c"));
    const dIdx = result.indexOf(taskItemId("d"));
    expect(aIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeLessThan(cIdx);
    expect(bIdx).toBeLessThan(dIdx);
    expect(cIdx).toBeLessThan(dIdx);
  });

  test("handles disconnected components", () => {
    const items = toMap([item("a"), item("b"), item("c")]);
    const result = topologicalSort(items);
    expect(result).toHaveLength(3);
  });
});
