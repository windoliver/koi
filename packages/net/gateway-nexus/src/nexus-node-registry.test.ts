import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AdvertisedTool, CapacityReport, KoiError, Result } from "@koi/core";
import type { RegisteredNode } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { runNodeRegistryContractTests } from "@koi/test-utils";
import type { NexusNodeRegistryHandle } from "./nexus-node-registry.js";
import { createNexusNodeRegistry } from "./nexus-node-registry.js";

// ---------------------------------------------------------------------------
// Test NexusClient factory — concentrates the generic interface mock in one place.
// TypeScript cannot structurally satisfy a generic method from a concrete mock,
// so a single assertion here is unavoidable for test mocking.
// ---------------------------------------------------------------------------

function createTestNexusClient(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusClient {
  return { rpc: handler } as NexusClient;
}

// Run shared contract suite against Nexus-backed implementation
runNodeRegistryContractTests(() => {
  const client = createTestNexusClient(async () => ({ ok: true, value: null }));
  const handle = createNexusNodeRegistry({
    client,
    config: {
      nexusUrl: "http://localhost:2026",
      apiKey: "test-key",
      writeQueue: { flushIntervalMs: 60_000 },
    },
  });
  return handle.registry;
});

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

function createMockClient(): {
  readonly client: NexusClient;
  readonly calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }>;
} {
  const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];

  return {
    client: createTestNexusClient(async (method, params) => {
      calls.push({ method, params });
      return { ok: true, value: null };
    }),
    calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusNodeRegistry", () => {
  let mock: ReturnType<typeof createMockClient>;
  let handle: NexusNodeRegistryHandle;

  beforeEach(() => {
    mock = createMockClient();
    handle = createNexusNodeRegistry({
      client: mock.client,
      config: {
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        instanceId: "instance-1",
        writeQueue: { flushIntervalMs: 60_000 },
      },
    });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  test("register adds node to local map and enqueues immediate write", async () => {
    const node = makeNode();
    const r = handle.registry.register(node);
    expect(r.ok).toBe(true);
    expect(handle.registry.size()).toBe(1);
    expect(handle.registry.lookup("node-1")).toBeDefined();

    // Immediate write fires
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.calls.some((c) => c.method === "write")).toBe(true);
  });

  test("register rejects empty nodeId", () => {
    const r = handle.registry.register(makeNode({ nodeId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("register rejects duplicate nodeId", () => {
    handle.registry.register(makeNode());
    const r = handle.registry.register(makeNode());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });

  test("deregister removes node and cleans up tool index", () => {
    handle.registry.register(makeNode());
    const r = handle.registry.deregister("node-1");
    expect(r).toEqual({ ok: true, value: true });
    expect(handle.registry.size()).toBe(0);
    expect(handle.registry.findByTool("tool-a")).toEqual([]);
  });

  test("deregister returns false for unknown node", () => {
    const r = handle.registry.deregister("missing");
    expect(r).toEqual({ ok: true, value: false });
  });

  test("lookup returns node or undefined", () => {
    expect(handle.registry.lookup("missing")).toBeUndefined();
    const node = makeNode();
    handle.registry.register(node);
    expect(handle.registry.lookup("node-1")).toEqual(node);
  });

  test("findByTool returns nodes advertising a tool", () => {
    handle.registry.register(makeNode({ nodeId: "n1", tools: [{ name: "t1" }] }));
    handle.registry.register(makeNode({ nodeId: "n2", tools: [{ name: "t1" }, { name: "t2" }] }));
    expect(handle.registry.findByTool("t1")).toHaveLength(2);
    expect(handle.registry.findByTool("t2")).toHaveLength(1);
    expect(handle.registry.findByTool("t3")).toEqual([]);
  });

  test("nodes returns all registered nodes", () => {
    handle.registry.register(makeNode({ nodeId: "n1" }));
    handle.registry.register(makeNode({ nodeId: "n2" }));
    expect(handle.registry.nodes().size).toBe(2);
  });

  test("updateHeartbeat updates timestamp and enqueues coalesced write", () => {
    handle.registry.register(makeNode());
    const beforeCalls = mock.calls.length;
    const r = handle.registry.updateHeartbeat("node-1");
    expect(r.ok).toBe(true);
    const node = handle.registry.lookup("node-1");
    expect(node?.lastHeartbeat).toBeGreaterThanOrEqual(Date.now() - 100);
    // Coalesced — no immediate rpc call
    expect(mock.calls.length).toBe(beforeCalls);
  });

  test("updateHeartbeat returns NOT_FOUND for unknown node", () => {
    const r = handle.registry.updateHeartbeat("missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("updateCapacity updates and enqueues write", () => {
    handle.registry.register(makeNode());
    const newCap: CapacityReport = { current: 5, max: 10, available: 5 };
    const r = handle.registry.updateCapacity("node-1", newCap);
    expect(r.ok).toBe(true);
    expect(handle.registry.lookup("node-1")?.capacity).toEqual(newCap);
  });

  test("updateTools adds and removes tools correctly", () => {
    handle.registry.register(makeNode({ tools: [{ name: "t1" }, { name: "t2" }] }));
    const newTool: AdvertisedTool = { name: "t3" };
    const r = handle.registry.updateTools("node-1", [newTool], ["t1"]);
    expect(r.ok).toBe(true);

    const node = handle.registry.lookup("node-1");
    const toolNames = node?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toContain("t2");
    expect(toolNames).toContain("t3");
    expect(toolNames).not.toContain("t1");

    // Tool index updated
    expect(handle.registry.findByTool("t1")).toEqual([]);
    expect(handle.registry.findByTool("t3")).toHaveLength(1);
  });

  test("starts in healthy mode", () => {
    expect(handle.degradation().mode).toBe("healthy");
  });
});
