/**
 * Reusable contract test suite for any NodeRegistry implementation.
 *
 * Call `runNodeRegistryContractTests(factory)` with a factory that
 * creates a fresh registry per test group.
 */

import { describe, expect, test } from "bun:test";
import type { AdvertisedTool, CapacityReport } from "@koi/core";
import type { NodeRegistry, RegisteredNode } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(overrides?: Partial<RegisteredNode>): RegisteredNode {
  return {
    nodeId: "node-1",
    mode: "full",
    tools: [{ name: "tool-a" }],
    capacity: { current: 1, max: 10, available: 9 },
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    connId: "conn-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runNodeRegistryContractTests(
  createRegistry: () => NodeRegistry | Promise<NodeRegistry>,
): void {
  describe("NodeRegistry contract", () => {
    describe("register / deregister", () => {
      test("register adds node", async () => {
        const reg = await createRegistry();
        const r = reg.register(makeNode());
        expect(r.ok).toBe(true);
        expect(reg.size()).toBe(1);
      });

      test("register rejects empty nodeId", async () => {
        const reg = await createRegistry();
        const r = reg.register(makeNode({ nodeId: "" }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("VALIDATION");
      });

      test("register rejects duplicate nodeId", async () => {
        const reg = await createRegistry();
        reg.register(makeNode());
        const r = reg.register(makeNode());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      });

      test("deregister removes node", async () => {
        const reg = await createRegistry();
        reg.register(makeNode());
        const r = reg.deregister("node-1");
        expect(r).toEqual({ ok: true, value: true });
        expect(reg.size()).toBe(0);
      });

      test("deregister returns false for unknown node", async () => {
        const reg = await createRegistry();
        const r = reg.deregister("missing");
        expect(r).toEqual({ ok: true, value: false });
      });
    });

    describe("lookup / findByTool", () => {
      test("lookup returns registered node", async () => {
        const reg = await createRegistry();
        const node = makeNode();
        reg.register(node);
        expect(reg.lookup("node-1")).toEqual(node);
      });

      test("lookup returns undefined for unknown node", async () => {
        const reg = await createRegistry();
        expect(reg.lookup("missing")).toBeUndefined();
      });

      test("findByTool returns nodes advertising the tool", async () => {
        const reg = await createRegistry();
        reg.register(makeNode({ nodeId: "n1", tools: [{ name: "t1" }] }));
        reg.register(makeNode({ nodeId: "n2", tools: [{ name: "t1" }, { name: "t2" }] }));
        expect(reg.findByTool("t1")).toHaveLength(2);
        expect(reg.findByTool("t2")).toHaveLength(1);
        expect(reg.findByTool("t3")).toEqual([]);
      });

      test("findByTool cleans up after deregister", async () => {
        const reg = await createRegistry();
        reg.register(makeNode({ nodeId: "n1", tools: [{ name: "t1" }] }));
        reg.deregister("n1");
        expect(reg.findByTool("t1")).toEqual([]);
      });
    });

    describe("updates", () => {
      test("updateHeartbeat updates timestamp", async () => {
        const reg = await createRegistry();
        reg.register(makeNode({ lastHeartbeat: 0 }));
        const r = reg.updateHeartbeat("node-1");
        expect(r.ok).toBe(true);
        const node = reg.lookup("node-1");
        expect(node?.lastHeartbeat).toBeGreaterThan(0);
      });

      test("updateHeartbeat returns NOT_FOUND for missing node", async () => {
        const reg = await createRegistry();
        const r = reg.updateHeartbeat("missing");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
      });

      test("updateCapacity updates capacity report", async () => {
        const reg = await createRegistry();
        reg.register(makeNode());
        const newCap: CapacityReport = { current: 5, max: 10, available: 5 };
        const r = reg.updateCapacity("node-1", newCap);
        expect(r.ok).toBe(true);
        expect(reg.lookup("node-1")?.capacity).toEqual(newCap);
      });

      test("updateTools adds and removes tools", async () => {
        const reg = await createRegistry();
        reg.register(makeNode({ tools: [{ name: "t1" }, { name: "t2" }] }));
        const newTool: AdvertisedTool = { name: "t3" };
        const r = reg.updateTools("node-1", [newTool], ["t1"]);
        expect(r.ok).toBe(true);
        const tools = reg.lookup("node-1")?.tools.map((t) => t.name) ?? [];
        expect(tools).toContain("t2");
        expect(tools).toContain("t3");
        expect(tools).not.toContain("t1");
      });
    });

    describe("nodes / size", () => {
      test("nodes returns all registered", async () => {
        const reg = await createRegistry();
        reg.register(makeNode({ nodeId: "n1" }));
        reg.register(makeNode({ nodeId: "n2" }));
        expect(reg.nodes().size).toBe(2);
      });
    });
  });
}
