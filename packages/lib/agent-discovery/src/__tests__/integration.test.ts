import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, ExternalAgentDescriptor, SubsystemToken } from "@koi/core";
import { agentId, EXTERNAL_AGENTS, isAttachResult, toolToken } from "@koi/core";
import { createDiscoveryProvider } from "../component-provider.js";
import type { McpAgentSource, SystemCalls } from "../types.js";

function fakeAgent(): Agent {
  return {
    pid: { id: agentId("test"), name: "test", type: "worker", depth: 0 },
    manifest: { name: "test", description: "test" } as AgentManifest,
    state: "running",
    component: <T>(_t: SubsystemToken<T>): T | undefined => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(_p: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => new Map(),
  };
}

describe("agent-discovery integration", () => {
  test("3 sources contribute, MCP wins on shared name", async () => {
    const sc: SystemCalls = {
      which: async (b) => (b === "claude" ? "/bin/claude" : null),
      readDir: async () => ["claude.json"],
      readFile: async () =>
        JSON.stringify({
          name: "claude-code",
          transport: "cli",
          capabilities: ["fs"],
          command: "/bin/claude-fs",
        }),
      spawn: async () => ({ stdout: "", exitCode: 0 }),
    };
    const mcp: McpAgentSource = {
      name: "claude-code",
      isAgent: true,
      listTools: async () => ({
        ok: true as const,
        value: [{ name: "code_review" }],
      }),
    };
    const provider = createDiscoveryProvider({
      systemCalls: sc,
      registryDir: "/agents",
      mcpSources: [mcp],
    });
    const result = await provider.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    const claude = agents.find((a) => a.name === "claude-code");
    expect(claude?.source).toBe("mcp");
  });

  test("partial failure: MCP source rejects, PATH+FS still produce", async () => {
    const sc: SystemCalls = {
      which: async (b) => (b === "aider" ? "/bin/aider" : null),
      readDir: async () => ["custom.json"],
      readFile: async () =>
        JSON.stringify({
          name: "custom",
          transport: "cli",
          capabilities: ["x"],
        }),
      spawn: async () => ({ stdout: "", exitCode: 0 }),
    };
    const broken: McpAgentSource = {
      name: "x",
      isAgent: true,
      listTools: async () => {
        throw new Error("nope");
      },
    };
    const provider = createDiscoveryProvider({
      systemCalls: sc,
      registryDir: "/agents",
      mcpSources: [broken],
    });
    const result = await provider.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    expect(agents.some((a) => a.name === "aider")).toBe(true);
    expect(agents.some((a) => a.name === "custom")).toBe(true);
  });

  test("tool execute filters by transport", async () => {
    const sc: SystemCalls = {
      which: async (b) => (b === "aider" ? "/bin/aider" : null),
      readDir: async () => [],
      readFile: async () => "",
      spawn: async () => ({ stdout: "", exitCode: 0 }),
    };
    const mcp: McpAgentSource = {
      name: "mcp-x",
      isAgent: true,
      listTools: async () => ({
        ok: true as const,
        value: [{ name: "code_assist" }],
      }),
    };
    const provider = createDiscoveryProvider({
      systemCalls: sc,
      mcpSources: [mcp],
    });
    const result = await provider.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const tool = map.get(toolToken("discover_agents")) as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };
    const r = (await tool.execute({ transport: "cli" })) as {
      readonly agents: readonly ExternalAgentDescriptor[];
      readonly count: number;
    };
    expect(r.agents.every((a) => a.transport === "cli")).toBe(true);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });
});
