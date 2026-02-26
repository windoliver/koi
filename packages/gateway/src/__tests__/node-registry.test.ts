import { beforeEach, describe, expect, test } from "bun:test";
import type { NodeRegistry, RegisteredNode } from "../node-registry.js";
import { createInMemoryNodeRegistry } from "../node-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestNode(overrides?: Partial<RegisteredNode>): RegisteredNode {
  return {
    nodeId: overrides?.nodeId ?? crypto.randomUUID(),
    mode: overrides?.mode ?? "full",
    tools: overrides?.tools ?? [{ name: "search", description: "Search tool" }],
    capacity: overrides?.capacity ?? { current: 2, max: 10, available: 8 },
    connectedAt: overrides?.connectedAt ?? Date.now(),
    lastHeartbeat: overrides?.lastHeartbeat ?? Date.now(),
    connId: overrides?.connId ?? crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("NodeRegistry", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = createInMemoryNodeRegistry();
  });

  describe("register()", () => {
    test("registers a node successfully", () => {
      const node = createTestNode();
      const result = registry.register(node);
      expect(result.ok).toBe(true);
      expect(registry.size()).toBe(1);
    });

    test("rejects duplicate nodeId with CONFLICT", () => {
      const node = createTestNode({ nodeId: "node-1" });
      registry.register(node);
      const result = registry.register(createTestNode({ nodeId: "node-1" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
      }
    });

    test("rejects empty nodeId with VALIDATION", () => {
      const node = createTestNode({ nodeId: "" });
      const result = registry.register(node);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("indexes tools on register", () => {
      const node = createTestNode({
        tools: [{ name: "search" }, { name: "execute" }],
      });
      registry.register(node);
      expect(registry.findByTool("search")).toHaveLength(1);
      expect(registry.findByTool("execute")).toHaveLength(1);
    });
  });

  describe("deregister()", () => {
    test("removes an existing node", () => {
      const node = createTestNode({ nodeId: "node-1" });
      registry.register(node);
      const result = registry.deregister("node-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
      expect(registry.size()).toBe(0);
    });

    test("returns false for non-existent node", () => {
      const result = registry.deregister("no-such-node");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    test("cleans up tool index on deregister", () => {
      const node = createTestNode({
        nodeId: "node-1",
        tools: [{ name: "search" }],
      });
      registry.register(node);
      expect(registry.findByTool("search")).toHaveLength(1);

      registry.deregister("node-1");
      expect(registry.findByTool("search")).toHaveLength(0);
    });
  });

  describe("lookup()", () => {
    test("returns registered node", () => {
      const node = createTestNode({ nodeId: "node-1" });
      registry.register(node);
      const found = registry.lookup("node-1");
      expect(found).toBeDefined();
      expect(found?.nodeId).toBe("node-1");
    });

    test("returns undefined for non-existent node", () => {
      expect(registry.lookup("no-such-node")).toBeUndefined();
    });
  });

  describe("findByTool()", () => {
    test("returns nodes advertising a specific tool (O(1) via inverted index)", () => {
      const node1 = createTestNode({
        nodeId: "node-1",
        tools: [{ name: "search" }, { name: "execute" }],
      });
      const node2 = createTestNode({
        nodeId: "node-2",
        tools: [{ name: "search" }],
      });
      const node3 = createTestNode({
        nodeId: "node-3",
        tools: [{ name: "execute" }],
      });
      registry.register(node1);
      registry.register(node2);
      registry.register(node3);

      const searchNodes = registry.findByTool("search");
      expect(searchNodes).toHaveLength(2);
      const ids = searchNodes.map((n) => n.nodeId);
      expect(ids).toContain("node-1");
      expect(ids).toContain("node-2");

      const execNodes = registry.findByTool("execute");
      expect(execNodes).toHaveLength(2);
    });

    test("returns empty array for unknown tool", () => {
      expect(registry.findByTool("unknown-tool")).toHaveLength(0);
    });

    test("updates when nodes deregister", () => {
      const node1 = createTestNode({
        nodeId: "node-1",
        tools: [{ name: "search" }],
      });
      const node2 = createTestNode({
        nodeId: "node-2",
        tools: [{ name: "search" }],
      });
      registry.register(node1);
      registry.register(node2);
      expect(registry.findByTool("search")).toHaveLength(2);

      registry.deregister("node-1");
      expect(registry.findByTool("search")).toHaveLength(1);
      expect(registry.findByTool("search")[0]?.nodeId).toBe("node-2");
    });
  });

  describe("nodes()", () => {
    test("returns all registered nodes", () => {
      const node1 = createTestNode({ nodeId: "n1" });
      const node2 = createTestNode({ nodeId: "n2" });
      registry.register(node1);
      registry.register(node2);

      const all = registry.nodes();
      expect(all.size).toBe(2);
      expect(all.has("n1")).toBe(true);
      expect(all.has("n2")).toBe(true);
    });
  });

  describe("size()", () => {
    test("tracks registration count", () => {
      expect(registry.size()).toBe(0);
      registry.register(createTestNode({ nodeId: "a" }));
      expect(registry.size()).toBe(1);
      registry.register(createTestNode({ nodeId: "b" }));
      expect(registry.size()).toBe(2);
      registry.deregister("a");
      expect(registry.size()).toBe(1);
    });
  });

  describe("updateHeartbeat()", () => {
    test("updates lastHeartbeat for existing node", () => {
      const node = createTestNode({
        nodeId: "node-1",
        lastHeartbeat: 1000,
      });
      registry.register(node);

      const before = registry.lookup("node-1")?.lastHeartbeat;
      const result = registry.updateHeartbeat("node-1");
      expect(result.ok).toBe(true);
      const after = registry.lookup("node-1")?.lastHeartbeat;
      expect(after).toBeGreaterThanOrEqual(before ?? 0);
    });

    test("returns NOT_FOUND for non-existent node", () => {
      const result = registry.updateHeartbeat("no-such-node");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateCapacity()", () => {
    test("updates capacity for existing node", () => {
      const node = createTestNode({ nodeId: "node-1" });
      registry.register(node);

      const newCapacity = { current: 5, max: 10, available: 5 };
      const result = registry.updateCapacity("node-1", newCapacity);
      expect(result.ok).toBe(true);

      const updated = registry.lookup("node-1");
      expect(updated?.capacity).toEqual(newCapacity);
    });

    test("returns NOT_FOUND for non-existent node", () => {
      const result = registry.updateCapacity("no-such", {
        current: 0,
        max: 10,
        available: 10,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
