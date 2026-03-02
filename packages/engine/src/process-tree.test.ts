import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProcessState, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import type { ProcessTree } from "./process-tree.js";
import { createProcessTree } from "./process-tree.js";
import type { InMemoryRegistry } from "./registry.js";
import { createInMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  parentId?: string,
  phase: ProcessState = "created",
  spawner?: string,
): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation: 0,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
    ...(parentId !== undefined ? { parentId: agentId(parentId) } : {}),
    ...(spawner !== undefined ? { spawner: agentId(spawner) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcessTree", () => {
  let registry: InMemoryRegistry;
  let tree: ProcessTree;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
  });

  afterEach(async () => {
    await tree[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test("tracks parent-child on register", () => {
    registry.register(entry("root"));
    registry.register(entry("child-1", "root"));
    registry.register(entry("child-2", "root"));

    expect(tree.parentOf(agentId("child-1"))).toBe(agentId("root"));
    expect(tree.parentOf(agentId("child-2"))).toBe(agentId("root"));
    expect(tree.childrenOf(agentId("root"))).toEqual([agentId("child-1"), agentId("child-2")]);
  });

  test("removes on deregister", () => {
    registry.register(entry("root"));
    registry.register(entry("child-1", "root"));

    registry.deregister(agentId("child-1"));

    expect(tree.childrenOf(agentId("root"))).toEqual([]);
    expect(tree.parentOf(agentId("child-1"))).toBeUndefined();
  });

  test("descendantsOf returns full subtree", () => {
    registry.register(entry("root"));
    registry.register(entry("a", "root"));
    registry.register(entry("b", "root"));
    registry.register(entry("a1", "a"));
    registry.register(entry("a2", "a"));

    const desc = tree.descendantsOf(agentId("root"));
    expect(desc).toHaveLength(4);
    expect(desc).toContain(agentId("a"));
    expect(desc).toContain(agentId("b"));
    expect(desc).toContain(agentId("a1"));
    expect(desc).toContain(agentId("a2"));
  });

  test("depthOf returns correct depth", () => {
    registry.register(entry("root"));
    registry.register(entry("child", "root"));
    registry.register(entry("grandchild", "child"));

    expect(tree.depthOf(agentId("root"))).toBe(0);
    expect(tree.depthOf(agentId("child"))).toBe(1);
    expect(tree.depthOf(agentId("grandchild"))).toBe(2);
  });

  test("root agents have no parent", () => {
    registry.register(entry("root-1"));
    registry.register(entry("root-2"));

    expect(tree.parentOf(agentId("root-1"))).toBeUndefined();
    expect(tree.parentOf(agentId("root-2"))).toBeUndefined();
    expect(tree.size()).toBe(2);
  });

  test("dispose cleans up", async () => {
    registry.register(entry("root"));
    registry.register(entry("child", "root"));

    expect(tree.size()).toBe(2);

    await tree[Symbol.asyncDispose]();

    expect(tree.size()).toBe(0);
    expect(tree.childrenOf(agentId("root"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lineage (spawner chain)
// ---------------------------------------------------------------------------

describe("ProcessTree lineage", () => {
  let registry: InMemoryRegistry;
  let tree: ProcessTree;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
  });

  afterEach(async () => {
    await tree[Symbol.asyncDispose]();
    await registry[Symbol.asyncDispose]();
  });

  test("lineage returns spawner chain", () => {
    registry.register(entry("root"));
    registry.register(entry("child", "root", "created", "root"));
    registry.register(entry("grandchild", "child", "created", "child"));

    const lin = tree.lineage(agentId("grandchild"));
    expect(lin).toEqual([agentId("child"), agentId("root")]);
  });

  test("lineage returns empty array for root agent", () => {
    registry.register(entry("root"));

    expect(tree.lineage(agentId("root"))).toEqual([]);
  });

  test("lineage returns empty for unknown agent", () => {
    expect(tree.lineage(agentId("nonexistent"))).toEqual([]);
  });

  test("spawner tracked on register", () => {
    registry.register(entry("root"));
    registry.register(entry("child", "root", "created", "root"));

    const lin = tree.lineage(agentId("child"));
    expect(lin).toEqual([agentId("root")]);
  });

  test("spawner cleaned up on deregister", () => {
    registry.register(entry("root"));
    registry.register(entry("child", "root", "created", "root"));

    registry.deregister(agentId("child"));

    expect(tree.lineage(agentId("child"))).toEqual([]);
  });

  test("lineage handles deep chain", () => {
    registry.register(entry("a"));
    registry.register(entry("b", "a", "created", "a"));
    registry.register(entry("c", "b", "created", "b"));
    registry.register(entry("d", "c", "created", "c"));

    const lin = tree.lineage(agentId("d"));
    expect(lin).toEqual([agentId("c"), agentId("b"), agentId("a")]);
  });
});
