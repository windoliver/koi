import { describe, expect, it, mock } from "bun:test";
import type { AgentManifest, ComponentProvider, EngineAdapter, ProcessId } from "@koi/core";
import { agentId, token } from "@koi/core";
import type { NodeEvent } from "../types.js";
import { createAgentHost } from "./host.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePid(id: string): ProcessId {
  return { id: agentId(id), name: `Agent ${id}`, type: "worker", depth: 0 };
}

const testManifest: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  description: "A test agent",
  model: { name: "test-model" },
};

function makeEngine(engineId = "test-engine"): EngineAdapter {
  return {
    engineId,
    capabilities: { text: true, images: false, files: false, audio: false },
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

const emptyProviders: readonly ComponentProvider[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentHost", () => {
  const config = {
    maxAgents: 3,
    memoryWarningPercent: 80,
    memoryEvictionPercent: 90,
    monitorInterval: 30_000,
  };

  describe("dispatch", () => {
    it("creates an agent and returns ok", async () => {
      const host = createAgentHost(config);
      const result = await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pid.id).toBe(agentId("a1"));
        expect(result.value.state).toBe("running");
      }
    });

    it("rejects dispatch when at capacity", async () => {
      const host = createAgentHost(config);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), emptyProviders);
      await host.dispatch(makePid("a3"), testManifest, makeEngine(), emptyProviders);

      const result = await host.dispatch(makePid("a4"), testManifest, makeEngine(), emptyProviders);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMIT");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("rejects duplicate agent ID", async () => {
      const host = createAgentHost(config);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);

      const result = await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
      }
    });

    it("attaches components from providers", async () => {
      const host = createAgentHost(config);
      const provider: ComponentProvider = {
        name: "test-provider",
        attach: async () => new Map([["tool:calculator", { name: "calculator" }]]),
      };

      const result = await host.dispatch(makePid("a1"), testManifest, makeEngine(), [provider]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.has(token("tool:calculator"))).toBe(true);
      }
    });
  });

  describe("terminate", () => {
    it("removes an existing agent", async () => {
      const host = createAgentHost(config);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);

      const result = host.terminate("a1");
      expect(result.ok).toBe(true);
      expect(host.get("a1")).toBeUndefined();
    });

    it("returns NOT_FOUND for unknown agent", () => {
      const host = createAgentHost(config);
      const result = host.terminate("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("calls engine.dispose()", async () => {
      const host = createAgentHost(config);
      const engine = makeEngine();
      await host.dispatch(makePid("a1"), testManifest, engine, emptyProviders);
      host.terminate("a1");

      expect(engine.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("get and list", () => {
    it("returns undefined for unknown agent", () => {
      const host = createAgentHost(config);
      expect(host.get("nonexistent")).toBeUndefined();
    });

    it("lists all agents", async () => {
      const host = createAgentHost(config);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), emptyProviders);

      const agents = host.list();
      expect(agents.length).toBe(2);
    });
  });

  describe("capacity", () => {
    it("reports correct capacity", async () => {
      const host = createAgentHost(config);
      expect(host.capacity()).toEqual({ current: 0, max: 3, available: 3 });

      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      expect(host.capacity()).toEqual({ current: 1, max: 3, available: 2 });
    });
  });

  describe("terminateAll", () => {
    it("removes all agents", async () => {
      const host = createAgentHost(config);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), emptyProviders);

      host.terminateAll();
      expect(host.list().length).toBe(0);
      expect(host.capacity().current).toBe(0);
    });
  });

  describe("events", () => {
    it("emits agent_dispatched event", async () => {
      const host = createAgentHost(config);
      const events: NodeEvent[] = [];
      host.onEvent((e) => events.push(e));

      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("agent_dispatched");
    });

    it("emits agent_terminated event", async () => {
      const host = createAgentHost(config);
      const events: NodeEvent[] = [];
      host.onEvent((e) => events.push(e));

      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      host.terminate("a1");

      expect(events.length).toBe(2);
      expect(events[1]?.type).toBe("agent_terminated");
    });

    it("unsubscribes correctly", async () => {
      const host = createAgentHost(config);
      const events: NodeEvent[] = [];
      const unsub = host.onEvent((e) => events.push(e));

      await host.dispatch(makePid("a1"), testManifest, makeEngine(), emptyProviders);
      expect(events.length).toBe(1);

      unsub();
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), emptyProviders);
      expect(events.length).toBe(1); // no new events after unsub
    });
  });

  describe("agent crash isolation (P0)", () => {
    it("one agent's component error does not affect others", async () => {
      const host = createAgentHost(config);

      await host.dispatch(makePid("healthy"), testManifest, makeEngine(), emptyProviders);
      await host.dispatch(makePid("faulty"), testManifest, makeEngine(), emptyProviders);

      // Simulate: faulty agent gets terminated due to error
      host.terminate("faulty");

      // Healthy agent should still be accessible
      const healthy = host.get("healthy");
      expect(healthy).toBeDefined();
      expect(healthy?.state).toBe("running");
    });
  });
});
