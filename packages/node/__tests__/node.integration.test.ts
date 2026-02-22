/**
 * Integration tests for the full KoiNode lifecycle.
 *
 * Uses a real Bun WebSocket server (MockGateway) to test:
 * - Node creation with valid/invalid config
 * - Start → connect → handshake → stop lifecycle
 * - Agent dispatch/terminate through the node
 * - Capacity reporting after dispatch/terminate
 * - Event emission across subsystems
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentManifest, EngineAdapter, ProcessId } from "@koi/core";
import { createNode } from "../src/node.js";
import type { NodeEvent } from "../src/types.js";
import type { MockGateway } from "./helpers/mock-gateway.js";
import { createMockGateway } from "./helpers/mock-gateway.js";
import { waitForCondition } from "./helpers/wait.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePid(id: string): ProcessId {
  return { id, name: `Agent ${id}`, type: "worker", depth: 0 };
}

const testManifest: AgentManifest = {
  name: "integration-agent",
  version: "0.0.1",
  description: "Integration test agent",
  model: { name: "test-model" },
};

function makeEngine(): EngineAdapter {
  return {
    engineId: "test-engine",
    async *stream() {
      yield {
        kind: "done" as const,
        output: {
          content: [],
          stopReason: "completed" as const,
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
        },
      };
    },
    dispose: mock(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KoiNode integration", () => {
  let gateway: MockGateway;

  beforeEach(() => {
    gateway = createMockGateway();
  });

  afterEach(() => {
    gateway.close();
  });

  it("rejects invalid config", () => {
    const result = createNode({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("creates a node with valid config", () => {
    const result = createNode({ gateway: { url: gateway.url } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBeTruthy();
      expect(result.value.state()).toBe("stopped");
    }
  });

  it("starts and connects to gateway", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = result.value;
    await node.start();
    expect(node.state()).toBe("connected");

    // Gateway should have received a handshake frame
    await gateway.waitForFrames(1);
    const handshake = gateway.receivedFrames[0];
    expect(handshake?.type).toBe("node:handshake");

    await node.stop();
    expect(node.state()).toBe("stopped");
  });

  it("rejects dispatch before start", () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    const dispatchResult = node.dispatch(makePid("a1"), testManifest, makeEngine());
    expect(dispatchResult.ok).toBe(false);
    if (!dispatchResult.ok) {
      expect(dispatchResult.error.code).toBe("VALIDATION");
      expect(dispatchResult.error.message).toContain("stopped");
    }
  });

  it("dispatches and terminates agents", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    await node.start();

    // Dispatch
    const d1 = node.dispatch(makePid("a1"), testManifest, makeEngine());
    expect(d1.ok).toBe(true);
    if (d1.ok) {
      expect(d1.value.pid.id).toBe("a1");
      expect(d1.value.state).toBe("running");
    }

    expect(node.listAgents().length).toBe(1);
    expect(node.capacity().current).toBe(1);

    // Terminate
    const t1 = node.terminate("a1");
    expect(t1.ok).toBe(true);
    expect(node.listAgents().length).toBe(0);
    expect(node.capacity().current).toBe(0);

    await node.stop();
  });

  it("reports capacity correctly", async () => {
    const result = createNode({
      gateway: { url: gateway.url },
      resources: { maxAgents: 3 },
    });
    if (!result.ok) return;

    const node = result.value;
    await node.start();

    expect(node.capacity()).toEqual({ current: 0, max: 3, available: 3 });

    node.dispatch(makePid("a1"), testManifest, makeEngine());
    node.dispatch(makePid("a2"), testManifest, makeEngine());
    expect(node.capacity()).toEqual({ current: 2, max: 3, available: 1 });

    node.terminate("a1");
    expect(node.capacity()).toEqual({ current: 1, max: 3, available: 2 });

    await node.stop();
  });

  it("emits events across subsystems", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    const events: NodeEvent[] = [];
    node.onEvent((e) => events.push(e));

    await node.start();

    // Dispatch and terminate to generate events
    node.dispatch(makePid("a1"), testManifest, makeEngine());
    node.terminate("a1");

    await node.stop();

    const types = events.map((e) => e.type);
    expect(types).toContain("connected");
    expect(types).toContain("agent_dispatched");
    expect(types).toContain("agent_terminated");
    expect(types).toContain("shutdown_started");
    expect(types).toContain("shutdown_complete");
  });

  it("unsubscribes event listeners", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    const events: NodeEvent[] = [];
    const unsub = node.onEvent((e) => events.push(e));

    await node.start();
    const countAfterStart = events.length;

    unsub();
    node.dispatch(makePid("a1"), testManifest, makeEngine());

    // No new events after unsub
    expect(events.length).toBe(countAfterStart);
    await node.stop();
  });

  it("getAgent returns agent or undefined", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    await node.start();

    expect(node.getAgent("nonexistent")).toBeUndefined();

    node.dispatch(makePid("a1"), testManifest, makeEngine());
    const agent = node.getAgent("a1");
    expect(agent).toBeDefined();
    expect(agent?.pid.id).toBe("a1");

    await node.stop();
  });

  it("handles gateway-initiated agent:terminate", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    await node.start();

    node.dispatch(makePid("a1"), testManifest, makeEngine());
    expect(node.getAgent("a1")).toBeDefined();

    // Gateway sends terminate frame
    gateway.broadcast({
      nodeId: node.nodeId,
      agentId: "a1",
      correlationId: "gw-1",
      type: "agent:terminate",
      payload: {},
    });

    // Wait for frame to be processed
    await waitForCondition(() => node.getAgent("a1") === undefined);

    expect(node.getAgent("a1")).toBeUndefined();
    expect(node.listAgents().length).toBe(0);

    await node.stop();
  });

  it("stop is idempotent", async () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;

    const node = result.value;
    await node.start();
    await node.stop();
    await node.stop(); // should not throw
    expect(node.state()).toBe("stopped");
  });

  it("provides access to tool resolver", () => {
    const result = createNode({ gateway: { url: gateway.url } });
    if (!result.ok) return;
    expect(result.value.toolResolver).toBeDefined();
  });
});
