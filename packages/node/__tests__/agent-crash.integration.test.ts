/**
 * Integration tests for agent crash isolation.
 *
 * Verifies that one agent's failure does not affect:
 * - Other agents on the same node
 * - The node's ability to dispatch new agents
 * - Gateway communication
 *
 * P0 scenarios: crash isolation is a critical safety property.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentManifest, EngineAdapter, ProcessId } from "@koi/core";
import type { KoiNode } from "../src/node.js";
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
  name: "crash-test-agent",
  version: "0.0.1",
  description: "Agent for crash isolation testing",
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

function makeFailingEngine(): EngineAdapter {
  return {
    engineId: "failing-engine",
    async *stream() {
      yield { kind: "text_delta" as const, delta: "" };
      throw new Error("Engine failure: simulated crash");
    },
    dispose: mock(() => Promise.reject(new Error("dispose failed"))),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent crash isolation", () => {
  let gateway: MockGateway;
  let node: KoiNode;

  beforeEach(async () => {
    gateway = createMockGateway();
    const result = createNode({
      gateway: { url: gateway.url },
      resources: { maxAgents: 10 },
    });
    if (!result.ok) throw new Error("Failed to create node");
    node = result.value;
    await node.start();
  });

  afterEach(async () => {
    await node.stop();
    gateway.close();
  });

  it("terminating one agent does not affect others", () => {
    node.dispatch(makePid("healthy-1"), testManifest, makeEngine());
    node.dispatch(makePid("healthy-2"), testManifest, makeEngine());
    node.dispatch(makePid("faulty"), testManifest, makeEngine());

    // Terminate the faulty agent
    const result = node.terminate("faulty");
    expect(result.ok).toBe(true);

    // Healthy agents remain accessible and running
    const h1 = node.getAgent("healthy-1");
    const h2 = node.getAgent("healthy-2");
    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h1?.state).toBe("running");
    expect(h2?.state).toBe("running");
    expect(node.listAgents().length).toBe(2);
  });

  it("faulty engine dispose does not block other terminations", () => {
    const failingEngine = makeFailingEngine();
    node.dispatch(makePid("healthy"), testManifest, makeEngine());
    node.dispatch(makePid("faulty"), testManifest, failingEngine);

    // Terminating faulty agent (dispose will reject, but should be caught)
    node.terminate("faulty");

    // Healthy agent should still be fine
    const healthy = node.getAgent("healthy");
    expect(healthy).toBeDefined();
    expect(healthy?.state).toBe("running");

    // Node can still dispatch new agents
    const d = node.dispatch(makePid("new-1"), testManifest, makeEngine());
    expect(d.ok).toBe(true);
  });

  it("capacity is freed after crash/terminate", () => {
    node.dispatch(makePid("a1"), testManifest, makeEngine());
    node.dispatch(makePid("a2"), testManifest, makeEngine());
    node.dispatch(makePid("a3"), testManifest, makeEngine());
    expect(node.capacity().current).toBe(3);

    // Simulate crash by terminating
    node.terminate("a2");
    expect(node.capacity().current).toBe(2);
    expect(node.capacity().available).toBe(8); // maxAgents=10, 2 active

    // Can dispatch a replacement
    const d = node.dispatch(makePid("a2-replacement"), testManifest, makeEngine());
    expect(d.ok).toBe(true);
    expect(node.capacity().current).toBe(3);
  });

  it("gateway-initiated terminate isolates correctly", async () => {
    node.dispatch(makePid("keep-alive"), testManifest, makeEngine());
    node.dispatch(makePid("to-kill"), testManifest, makeEngine());

    // Gateway sends terminate for one agent
    gateway.broadcast({
      nodeId: node.nodeId,
      agentId: "to-kill",
      correlationId: "gw-terminate-1",
      type: "agent:terminate",
      payload: {},
    });

    await waitForCondition(() => node.getAgent("to-kill") === undefined);

    expect(node.getAgent("to-kill")).toBeUndefined();
    expect(node.getAgent("keep-alive")).toBeDefined();
    expect(node.getAgent("keep-alive")?.state).toBe("running");
  });

  it("emits agent_terminated events correctly", () => {
    const events: NodeEvent[] = [];
    node.onEvent((e) => events.push(e));

    node.dispatch(makePid("a1"), testManifest, makeEngine());
    node.dispatch(makePid("a2"), testManifest, makeEngine());
    node.terminate("a1");

    const terminated = events.filter((e) => e.type === "agent_terminated");
    expect(terminated.length).toBe(1);

    const dispatched = events.filter((e) => e.type === "agent_dispatched");
    expect(dispatched.length).toBe(2);
  });

  it("node remains functional after multiple agent terminations", () => {
    // Dispatch and terminate in rapid succession
    for (let i = 0; i < 5; i++) {
      const id = `rapid-${i}`;
      const d = node.dispatch(makePid(id), testManifest, makeEngine());
      expect(d.ok).toBe(true);
      node.terminate(id);
    }

    expect(node.listAgents().length).toBe(0);
    expect(node.capacity().current).toBe(0);

    // Node still works
    const d = node.dispatch(makePid("after-rapid"), testManifest, makeEngine());
    expect(d.ok).toBe(true);
    expect(node.listAgents().length).toBe(1);
  });
});
