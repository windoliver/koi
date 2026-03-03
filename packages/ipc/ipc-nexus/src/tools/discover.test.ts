import { describe, expect, mock, test } from "bun:test";
import type { AgentRegistry, VisibilityContext } from "@koi/core";
import { agentId } from "@koi/core";
import { createMockRegistry } from "../test-helpers.js";
import { createDiscoverTool } from "./discover.js";

describe("createDiscoverTool", () => {
  test("has correct descriptor", () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    expect(tool.descriptor.name).toBe("ipc_discover");
    expect(tool.descriptor.description).toBeTruthy();
    expect(tool.trustTier).toBe("verified");
  });

  test("respects custom prefix", () => {
    const tool = createDiscoverTool(createMockRegistry(), "msg", "promoted");
    expect(tool.descriptor.name).toBe("msg_discover");
    expect(tool.trustTier).toBe("promoted");
  });

  test("returns running agents by default (no args)", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({})) as {
      agents: readonly { agentId: string; phase: string }[];
    };

    expect(result.agents).toHaveLength(2);
    for (const agent of result.agents) {
      expect(agent.phase).toBe("running");
    }
  });

  test("filters by agentType", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ agentType: "worker" })) as {
      agents: readonly { agentId: string; agentType: string }[];
    };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.agentType).toBe("worker");
  });

  test("filters by phase", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ phase: "suspended" })) as {
      agents: readonly { agentId: string; phase: string }[];
    };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.phase).toBe("suspended");
  });

  test("filters by both agentType and phase", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ agentType: "worker", phase: "running" })) as {
      agents: readonly { agentId: string; agentType: string; phase: string }[];
    };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.agentType).toBe("worker");
    expect(result.agents[0]?.phase).toBe("running");
  });

  test("returns simplified shape with agentId, agentType, phase, registeredAt", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ agentType: "copilot" })) as {
      agents: readonly Record<string, unknown>[];
    };

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0];
    expect(agent).toEqual({
      agentId: agentId("copilot-1"),
      agentType: "copilot",
      phase: "running",
      registeredAt: 1_700_000_000_000,
    });
  });

  test("returns empty agents array when no matches", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ phase: "terminated" })) as {
      agents: readonly unknown[];
    };

    expect(result.agents).toEqual([]);
  });

  test("returns validation error for invalid agentType", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ agentType: "manager" })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("Invalid agentType");
    expect(result.error).toContain("manager");
  });

  test("returns validation error for invalid phase", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ phase: "paused" })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("Invalid phase");
    expect(result.error).toContain("paused");
  });

  test("returns validation error for non-string agentType", async () => {
    const tool = createDiscoverTool(createMockRegistry(), "ipc", "verified");
    const result = (await tool.execute({ agentType: 42 })) as {
      error: string;
      code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("Invalid agentType");
  });

  test("returns internal error when registry throws", async () => {
    const registry = createMockRegistry();
    const failingRegistry = {
      ...registry,
      list: () => {
        throw new Error("registry unavailable");
      },
    };

    const tool = createDiscoverTool(failingRegistry, "ipc", "verified");
    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("registry unavailable");
  });

  // -----------------------------------------------------------------------
  // Visibility filtering
  // -----------------------------------------------------------------------

  describe("visibility filtering", () => {
    test("passes callerId to registry.list as VisibilityContext", async () => {
      const baseRegistry = createMockRegistry();
      const listSpy = mock(baseRegistry.list);
      const registry: AgentRegistry = { ...baseRegistry, list: listSpy };

      const callerId = agentId("caller-agent");
      const tool = createDiscoverTool(registry, "ipc", "verified", callerId);
      await tool.execute({});

      expect(listSpy).toHaveBeenCalledTimes(1);
      const args = listSpy.mock.calls[0];
      // Second argument should be the VisibilityContext
      const vis = args?.[1] as VisibilityContext | undefined;
      expect(vis).toBeDefined();
      expect(vis?.callerId).toBe(callerId);
    });

    test("returns all agents when no callerId (backward compat)", async () => {
      const baseRegistry = createMockRegistry();
      const listSpy = mock(baseRegistry.list);
      const registry: AgentRegistry = { ...baseRegistry, list: listSpy };

      const tool = createDiscoverTool(registry, "ipc", "verified");
      const result = (await tool.execute({})) as {
        agents: readonly { agentId: string }[];
      };

      // Should still get results (mock registry has running agents)
      expect(result.agents.length).toBeGreaterThan(0);
      // Second argument should be undefined
      const args = listSpy.mock.calls[0];
      expect(args?.[1]).toBeUndefined();
    });
  });
});
