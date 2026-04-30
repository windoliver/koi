import { describe, expect, test } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { createDiscoverAgentsTool } from "./discover-agents-tool.js";
import type { DiscoveryHandle } from "./types.js";

const cliClaude: ExternalAgentDescriptor = {
  name: "claude-code",
  transport: "cli",
  capabilities: ["code-review"],
  source: "path",
};
const cliAider: ExternalAgentDescriptor = {
  name: "aider",
  transport: "cli",
  capabilities: ["code-generation"],
  source: "path",
};

function fakeDiscovery(
  agents: readonly ExternalAgentDescriptor[],
  override: Partial<DiscoveryHandle> = {},
): DiscoveryHandle {
  return {
    discover: async ({ filter } = {}) => {
      if (!filter) return agents;
      return agents.filter((a) => {
        if (filter.transport && a.transport !== filter.transport) return false;
        if (filter.capability && !a.capabilities.includes(filter.capability)) return false;
        if (filter.source && a.source !== filter.source) return false;
        return true;
      });
    },
    invalidate: () => {},
    ...override,
  };
}

describe("createDiscoverAgentsTool", () => {
  test("descriptor has correct name + inputSchema", () => {
    const tool = createDiscoverAgentsTool(fakeDiscovery([]));
    expect(tool.descriptor.name).toBe("discover_agents");
    expect(tool.descriptor.inputSchema).toMatchObject({
      type: "object",
      properties: {
        capability: { type: "string" },
        transport: { type: "string" },
        source: { type: "string" },
      },
      additionalProperties: false,
    });
  });

  test("execute({}) returns all agents with count", async () => {
    const tool = createDiscoverAgentsTool(fakeDiscovery([cliClaude, cliAider]));
    const r = await tool.execute({});
    expect(r).toEqual({ agents: [cliClaude, cliAider], count: 2 });
  });

  test("execute filters by transport", async () => {
    const mcpAgent: ExternalAgentDescriptor = {
      name: "x",
      transport: "mcp",
      capabilities: [],
      source: "mcp",
    };
    const tool = createDiscoverAgentsTool(fakeDiscovery([cliClaude, mcpAgent]));
    const r = await tool.execute({ transport: "cli" });
    expect(r).toEqual({ agents: [cliClaude], count: 1 });
  });

  test("execute returns empty on internal error (does not throw)", async () => {
    const tool = createDiscoverAgentsTool(
      fakeDiscovery([], {
        discover: async () => {
          throw new Error("boom");
        },
      }),
    );
    const r = await tool.execute({});
    expect(r).toEqual({ agents: [], count: 0 });
  });

  test("execute ignores invalid args (treats as empty filter)", async () => {
    const tool = createDiscoverAgentsTool(fakeDiscovery([cliClaude]));
    const r = await tool.execute({ unrelated: 5 });
    expect(r).toEqual({ agents: [cliClaude], count: 1 });
  });
});
