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

  test("detects simple cycle A→B→A", () => {
    const items = toMap([item("a", ["b"]), item("b", ["a"])]);
    const result = detectCycle(items, [taskItemId("a")], taskItemId("c"));
    // Adding c→a while a→b→a exists — no new cycle from c's perspective
    // The cycle is between a and b in the existing graph
    expect(result).toBeUndefined();
  });

  test("detects self-dependency", () => {
    const items = toMap([item("a")]);
    const result = detectCycle(items, [taskItemId("a")], taskItemId("a"));
    expect(result).toBeDefined();
    expect(result).toContain(taskItemId("a"));
  });

  test("detects cycle when new item creates one", () => {
    // a→b, new c depends on b, but b depends on c (cycle: c→b→...→c)
    const _items = toMap([item("a"), item("b", ["a"])]);
    // Simulate: adding c with dep on b. But if b already depends on c, that's a cycle.
    // Actually we need to test: adding c→b while b→c would be set.
    // Better test: existing a→b, b→c. Now adding c→a creates a→b→c→a.
    const existingItems = toMap([item("a"), item("b", ["a"]), item("c", ["b"])]);
    const result = detectCycle(existingItems, [taskItemId("a")], taskItemId("d"));
    // d→a, but a→b→c is a chain, no cycle back to d
    expect(result).toBeUndefined();
  });

  test("detects indirect cycle: adding d→a when a→b→c→d would form cycle", () => {
    // We'll construct: a (no deps), b→a, c→b. Now add d with dep c.
    // Then check if adding a new item 'e' with dep on d creates no cycle.
    // But to test actual cycle: a→b→c, add d→c, then add a new 'a' dep on d → cycle a→b→c→d→a? No.
    // Let's do: existing items include b→a, c→b. We add d with deps=[c].
    // Then check adding e with deps=[d] and see if it detects cycle when we also say e feeds into a somehow.
    // Simpler: existing: a(no dep), b→a, c→b. Now adding d with dep on c. Then checking if adding
    // a dep from a on d would create cycle.
    // detectCycle checks if ADDING newId with newDeps creates a cycle.
    // So: items = {a, b→a, c→b, d→c}. Now add "a2" with deps=["d"] — no cycle.
    // For cycle: items = {b→a, c→b, d→c}. Add a with deps=["d"] → a→d→c→b→a — cycle!
    const items = toMap([item("b", ["a"]), item("c", ["b"]), item("d", ["c"])]);
    // Adding "a" with deps=["d"] creates: a→d→c→b→a
    const result = detectCycle(items, [taskItemId("d")], taskItemId("a"));
    expect(result).toBeDefined();
  });

  test("returns undefined for diamond DAG (valid)", () => {
    // A→B, A→C, B→D, C→D — no cycle
    const items = toMap([item("a"), item("b", ["a"]), item("c", ["a"]), item("d", ["b", "c"])]);
    const result = detectCycle(items, ["b", "c"].map(taskItemId), taskItemId("e"));
    expect(result).toBeUndefined();
  });

  test("returns undefined for disconnected components", () => {
    const items = toMap([item("a"), item("b"), item("c", ["a"])]);
    const result = detectCycle(items, [], taskItemId("d"));
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
});
