import { describe, expect, it, mock } from "bun:test";
import type { AgentManifest, EngineAdapter, ProcessId } from "@koi/core";
import { agentId } from "@koi/core";
import type { NodeFrame } from "../types.js";
import { createAgentHost } from "./host.js";
import { createStatusReporter } from "./status.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePid(id: string): ProcessId {
  return { id: agentId(id), name: `Agent ${id}`, type: "worker", depth: 0 };
}

const testManifest: AgentManifest = {
  name: "status-test-agent",
  version: "0.0.1",
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

const hostConfig = {
  maxAgents: 10,
  memoryWarningPercent: 80,
  memoryEvictionPercent: 90,
  monitorInterval: 30_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatusReporter", () => {
  describe("collect", () => {
    it("returns empty array when no agents", () => {
      const host = createAgentHost(hostConfig);
      const reporter = createStatusReporter("node-1", host, mock());

      const statuses = reporter.collect();
      expect(statuses).toEqual([]);
    });

    it("collects status for all agents", async () => {
      const host = createAgentHost(hostConfig);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), []);
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), []);

      const reporter = createStatusReporter("node-1", host, mock());
      const statuses = reporter.collect();

      expect(statuses.length).toBe(2);
      const ids = statuses.map((s) => s.agentId);
      expect(ids).toContain("a1");
      expect(ids).toContain("a2");
    });

    it("reports running state", async () => {
      const host = createAgentHost(hostConfig);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), []);

      const reporter = createStatusReporter("node-1", host, mock());
      const statuses = reporter.collect();

      expect(statuses[0]?.state).toBe("running");
    });

    it("reflects terminated agents (not collected)", async () => {
      const host = createAgentHost(hostConfig);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), []);
      await host.dispatch(makePid("a2"), testManifest, makeEngine(), []);
      host.terminate("a1");

      const reporter = createStatusReporter("node-1", host, mock());
      const statuses = reporter.collect();

      expect(statuses.length).toBe(1);
      expect(statuses[0]?.agentId).toBe("a2");
    });
  });

  describe("periodic reporting", () => {
    it("sends batched frame on interval", async () => {
      const host = createAgentHost(hostConfig);
      await host.dispatch(makePid("a1"), testManifest, makeEngine(), []);

      const sentFrames: NodeFrame[] = [];
      const sendFrame = mock((frame: NodeFrame) => {
        sentFrames.push(frame);
      });

      const reporter = createStatusReporter("node-1", host, sendFrame, 30);
      reporter.start();

      await new Promise((r) => setTimeout(r, 80));
      reporter.stop();

      expect(sentFrames.length).toBeGreaterThanOrEqual(1);
      // Verify batched format
      const frame = sentFrames[0];
      expect(frame?.type).toBe("agent:status");
      expect(frame?.agentId).toBe("");

      const payload = frame?.payload as { agents: unknown[] };
      expect(payload.agents.length).toBe(1);
    });

    it("does not send frame when no agents", async () => {
      const host = createAgentHost(hostConfig);
      const sendFrame = mock(() => {});

      const reporter = createStatusReporter("node-1", host, sendFrame, 30);
      reporter.start();

      await new Promise((r) => setTimeout(r, 80));
      reporter.stop();

      expect(sendFrame).not.toHaveBeenCalled();
    });

    it("is idempotent on start", () => {
      const host = createAgentHost(hostConfig);
      const reporter = createStatusReporter("node-1", host, mock(), 30);

      reporter.start();
      reporter.start(); // no-op
      reporter.stop();
    });

    it("stop is safe when not started", () => {
      const host = createAgentHost(hostConfig);
      const reporter = createStatusReporter("node-1", host, mock());
      reporter.stop(); // should not throw
    });
  });
});
