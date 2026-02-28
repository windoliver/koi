import { describe, expect, it } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { createDiscoverAgentsTool } from "./discover-agents-tool.js";
import type { DiscoveryHandle } from "./discovery.js";

const agentA: ExternalAgentDescriptor = {
  name: "agent-a",
  transport: "cli",
  capabilities: ["code-generation"],
  healthy: true,
  source: "path",
};

const agentB: ExternalAgentDescriptor = {
  name: "agent-b",
  transport: "mcp",
  capabilities: ["code-review"],
  healthy: true,
  source: "mcp",
};

function createMockDiscovery(agents: readonly ExternalAgentDescriptor[]): DiscoveryHandle {
  return {
    discover: async (options) => {
      const filter = options?.filter;
      if (filter === undefined) return agents;
      return agents.filter((a) => {
        if (filter.capability !== undefined && !a.capabilities.includes(filter.capability))
          return false;
        if (filter.transport !== undefined && a.transport !== filter.transport) return false;
        if (filter.source !== undefined && a.source !== filter.source) return false;
        return true;
      });
    },
    invalidate: () => {},
  };
}

describe("createDiscoverAgentsTool", () => {
  it("returns all agents when called with empty args", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({})) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(2);
    expect(result.agents).toHaveLength(2);
  });

  it("filters by capability", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({ capability: "code-generation" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.agents[0]?.name).toBe("agent-a");
  });

  it("filters by transport", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({ transport: "mcp" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.agents[0]?.name).toBe("agent-b");
  });

  it("filters by source", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({ source: "path" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.agents[0]?.name).toBe("agent-a");
  });

  it("ignores invalid transport values", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({ transport: "pigeon" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    // Invalid transport → filter dropped → returns all
    expect(result.count).toBe(2);
  });

  it("ignores invalid source values", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA, agentB]));

    const result = (await tool.execute({ source: "carrier-pigeon" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(2);
  });

  it("ignores non-string args gracefully", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA]));

    const result = (await tool.execute({
      capability: 42,
      transport: null,
      source: true,
    })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(1);
  });

  it("has correct descriptor shape", () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([]));

    expect(tool.descriptor.name).toBe("discover_agents");
    expect(tool.descriptor.description).toContain("external coding agents");
    expect(tool.trustTier).toBe("verified");
    expect(tool.descriptor.inputSchema.type).toBe("object");
  });

  it("returns empty result when no agents match", async () => {
    const tool = createDiscoverAgentsTool(createMockDiscovery([agentA]));

    const result = (await tool.execute({ capability: "nonexistent" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };

    expect(result.count).toBe(0);
    expect(result.agents).toHaveLength(0);
  });
});
