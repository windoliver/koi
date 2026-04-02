import { describe, expect, test } from "bun:test";
import type { Task, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { detectCycle, topologicalSort } from "./dag.js";

function task(id: string, deps: readonly string[] = []): Task {
  return {
    id: taskItemId(id),
    subject: `Task ${id}`,
    description: `Task ${id}`,
    dependencies: deps.map(taskItemId),
    status: "pending",
    retries: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function toMap(items: readonly Task[]): ReadonlyMap<TaskItemId, Task> {
  return new Map(items.map((i) => [i.id, i]));
}

describe("detectCycle", () => {
  test("returns undefined for empty graph", () => {
    const items = toMap([]);
    const result = detectCycle(items, [], taskItemId("a"));
    expect(result).toBeUndefined();
  });

  test("returns undefined for linear chain A→B→C", () => {
    const items = toMap([task("a"), task("b", ["a"]), task("c", ["b"])]);
    const result = detectCycle(items, [taskItemId("c")], taskItemId("d"));
    expect(result).toBeUndefined();
  });

  test("detects self-dependency", () => {
    const items = toMap([task("a")]);
    const result = detectCycle(items, [taskItemId("a")], taskItemId("a"));
    expect(result).toBeDefined();
    expect(result).toContain(taskItemId("a"));
  });

  test("detects indirect cycle", () => {
    const items = toMap([task("b", ["a"]), task("c", ["b"]), task("d", ["c"])]);
    const result = detectCycle(items, [taskItemId("d")], taskItemId("a"));
    expect(result).toBeDefined();
  });

  test("returns undefined for diamond DAG (valid)", () => {
    const items = toMap([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]);
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
    const result = topologicalSort(toMap([task("a")]));
    expect(result).toEqual([taskItemId("a")]);
  });

  test("returns linear chain in order", () => {
    const items = toMap([task("c", ["b"]), task("b", ["a"]), task("a")]);
    const result = topologicalSort(items);
    const aIdx = result.indexOf(taskItemId("a"));
    const bIdx = result.indexOf(taskItemId("b"));
    const cIdx = result.indexOf(taskItemId("c"));
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  test("respects diamond dependencies", () => {
    const items = toMap([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]);
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
    const items = toMap([task("a"), task("b"), task("c")]);
    const result = topologicalSort(items);
    expect(result).toHaveLength(3);
  });
});
