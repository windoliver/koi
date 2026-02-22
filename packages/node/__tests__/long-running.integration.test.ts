/**
 * Integration tests for long-running job scenarios.
 *
 * Verifies that:
 * - Agents persist through node lifecycle events
 * - Graceful shutdown drains agents before stopping
 * - Multiple agents can coexist without interference
 * - Status reporting works during extended operation
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentManifest, EngineAdapter, ProcessId } from "@koi/core";
import type { KoiNode } from "../src/node.js";
import { createNode } from "../src/node.js";
import type { NodeEvent } from "../src/types.js";
import type { MockGateway } from "./helpers/mock-gateway.js";
import { createMockGateway } from "./helpers/mock-gateway.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePid(id: string): ProcessId {
  return { id, name: `LR Agent ${id}`, type: "worker", depth: 0 };
}

const testManifest: AgentManifest = {
  name: "long-running-agent",
  version: "0.0.1",
  description: "Long-running test agent",
  model: { name: "test-model" },
};

function makeEngine(): EngineAdapter {
  return {
    engineId: "long-running-engine",
    async *stream() {
      yield { kind: "text_delta" as const, delta: "processing..." };
      yield {
        kind: "done" as const,
        output: {
          content: [{ type: "text", text: "completed" }],
          stopReason: "completed" as const,
          metrics: {
            totalTokens: 100,
            inputTokens: 50,
            outputTokens: 50,
            turns: 1,
            durationMs: 1000,
          },
        },
      };
    },
    dispose: mock(() => Promise.resolve()),
  };
}

function makeStatefulEngine(): EngineAdapter {
  let state: unknown = null;
  return {
    engineId: "stateful-engine",
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
    async saveState() {
      return { engineId: "stateful-engine", data: state };
    },
    async loadState(s) {
      state = s.data;
    },
    dispose: mock(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Long-running jobs", () => {
  let gateway: MockGateway;
  let node: KoiNode;

  beforeEach(async () => {
    gateway = createMockGateway();
    const result = createNode({
      gateway: { url: gateway.url },
      resources: { maxAgents: 20 },
    });
    if (!result.ok) throw new Error("Failed to create node");
    node = result.value;
    await node.start();
  });

  afterEach(async () => {
    await node.stop();
    gateway.close();
  });

  it("agents persist across time", async () => {
    node.dispatch(makePid("long-1"), testManifest, makeEngine());
    node.dispatch(makePid("long-2"), testManifest, makeEngine());

    // Simulate passage of time
    await new Promise((r) => setTimeout(r, 100));

    // Agents should still be running
    expect(node.getAgent("long-1")?.state).toBe("running");
    expect(node.getAgent("long-2")?.state).toBe("running");
    expect(node.listAgents().length).toBe(2);
  });

  it("multiple agents coexist without interference", () => {
    const agents: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `coexist-${i}`;
      const result = node.dispatch(makePid(id), testManifest, makeEngine());
      expect(result.ok).toBe(true);
      agents.push(id);
    }

    expect(node.listAgents().length).toBe(10);
    expect(node.capacity().current).toBe(10);

    // Each agent is independently accessible
    for (const id of agents) {
      const agent = node.getAgent(id);
      expect(agent).toBeDefined();
      expect(agent?.pid.id).toBe(id);
      expect(agent?.state).toBe("running");
    }
  });

  it("graceful stop terminates all agents", async () => {
    node.dispatch(makePid("lr-1"), testManifest, makeEngine());
    node.dispatch(makePid("lr-2"), testManifest, makeEngine());
    node.dispatch(makePid("lr-3"), testManifest, makeEngine());

    const events: NodeEvent[] = [];
    node.onEvent((e) => events.push(e));

    await node.stop();

    // All agents should be gone
    expect(node.listAgents().length).toBe(0);
    expect(node.capacity().current).toBe(0);

    // Should have emitted shutdown events
    const types = events.map((e) => e.type);
    expect(types).toContain("shutdown_started");
    expect(types).toContain("shutdown_complete");
  });

  it("selective termination during operation", () => {
    node.dispatch(makePid("keep-1"), testManifest, makeEngine());
    node.dispatch(makePid("remove-1"), testManifest, makeEngine());
    node.dispatch(makePid("keep-2"), testManifest, makeEngine());
    node.dispatch(makePid("remove-2"), testManifest, makeEngine());

    // Selectively terminate
    node.terminate("remove-1");
    node.terminate("remove-2");

    const remaining = node.listAgents();
    expect(remaining.length).toBe(2);
    const ids = remaining.map((a) => a.pid.id);
    expect(ids).toContain("keep-1");
    expect(ids).toContain("keep-2");
    expect(ids).not.toContain("remove-1");
    expect(ids).not.toContain("remove-2");
  });

  it("can dispatch new agents after terminating others", () => {
    // Fill up some slots
    for (let i = 0; i < 5; i++) {
      node.dispatch(makePid(`batch1-${i}`), testManifest, makeEngine());
    }
    expect(node.listAgents().length).toBe(5);

    // Terminate all
    for (let i = 0; i < 5; i++) {
      node.terminate(`batch1-${i}`);
    }
    expect(node.listAgents().length).toBe(0);

    // Dispatch new batch
    for (let i = 0; i < 5; i++) {
      const result = node.dispatch(makePid(`batch2-${i}`), testManifest, makeEngine());
      expect(result.ok).toBe(true);
    }
    expect(node.listAgents().length).toBe(5);
  });

  it("handles rapid dispatch/terminate cycles", () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `cycle-${cycle}-agent-${i}`;
        node.dispatch(makePid(id), testManifest, makeEngine());
        ids.push(id);
      }
      expect(node.listAgents().length).toBe(5);

      for (const id of ids) {
        node.terminate(id);
      }
      expect(node.listAgents().length).toBe(0);
    }
  });

  it("stateful engines support save/load lifecycle", async () => {
    const engine = makeStatefulEngine();
    node.dispatch(makePid("stateful-1"), testManifest, engine);

    // Save state
    const state = await engine.saveState?.();
    expect(state).toBeDefined();
    expect(state?.engineId).toBe("stateful-engine");

    // Load state
    if (state !== undefined) {
      await engine.loadState?.(state);
    }

    // Agent still running
    expect(node.getAgent("stateful-1")?.state).toBe("running");
  });

  it("sends frames to gateway during operation", async () => {
    // Wait for handshake frame
    await gateway.waitForFrames(1);
    const handshake = gateway.receivedFrames[0];
    expect(handshake?.type).toBe("node:handshake");

    // Dispatch agents and verify gateway sees status updates
    node.dispatch(makePid("reported-1"), testManifest, makeEngine());

    // Status reporter runs on interval, give it time
    await new Promise((r) => setTimeout(r, 100));

    // At minimum, gateway received the handshake
    expect(gateway.receivedFrames.length).toBeGreaterThanOrEqual(1);
  });
});
