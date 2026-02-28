/**
 * Integration test — full pipeline with all 3 sources (mocked).
 *
 * Verifies: discover → dedup → filter → tool response → partial failure.
 */

import { describe, expect, it } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  AttachResult,
  ExternalAgentDescriptor,
  JsonObject,
  ProcessId,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { EXTERNAL_AGENTS, isAttachResult, toolToken } from "@koi/core";

/** Extract the components map from an attach result (handles union return type). */
function getComponents(
  result: ReadonlyMap<string, unknown> | AttachResult,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import { createDiscoveryProvider } from "../component-provider.js";
import { createDiscoverAgentsTool } from "../discover-agents-tool.js";
import { createDiscovery } from "../discovery.js";
import type { DiscoverySource, McpAgentSource, SystemCalls } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubAgent(): Agent {
  const pid: ProcessId = {
    id: "int-test-agent" as AgentId,
    name: "integration-test",
    type: "copilot",
    depth: 0,
  };
  const components = new Map<string, unknown>();
  return {
    pid,
    manifest: {} as AgentManifest,
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>): boolean => components.has(token as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

function createMockSource(
  name: string,
  descriptors: readonly ExternalAgentDescriptor[],
): DiscoverySource {
  return { name, discover: async () => descriptors };
}

function createFailingSource(name: string): DiscoverySource {
  return {
    name,
    discover: async () => {
      throw new Error(`${name} source unavailable`);
    },
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("agent-discovery integration", () => {
  it("full pipeline: 3 sources → dedup → filter → tool response", async () => {
    const pathAgent: ExternalAgentDescriptor = {
      name: "claude-code",
      displayName: "Claude Code",
      transport: "cli",
      command: "claude",
      capabilities: ["code-generation", "code-review"],
      healthy: true,
      source: "path",
    };
    const fsAgent: ExternalAgentDescriptor = {
      name: "custom-agent",
      transport: "a2a",
      capabilities: ["debugging"],
      source: "filesystem",
    };
    const mcpAgent: ExternalAgentDescriptor = {
      name: "mcp-server-x",
      transport: "mcp",
      capabilities: ["code-generation"],
      healthy: true,
      source: "mcp",
    };

    const pathSource = createMockSource("path", [pathAgent]);
    const fsSource = createMockSource("filesystem", [fsAgent]);
    const mcpSource = createMockSource("mcp", [mcpAgent]);

    const discovery = createDiscovery([pathSource, fsSource, mcpSource], 60_000);
    const tool = createDiscoverAgentsTool(discovery);

    // Discover all
    const allResult = (await tool.execute({})) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };
    expect(allResult.count).toBe(3);

    // Filter by capability
    const codeGenResult = (await tool.execute({ capability: "code-generation" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };
    expect(codeGenResult.count).toBe(2);

    // Filter by transport
    const cliResult = (await tool.execute({ transport: "cli" })) as {
      agents: readonly ExternalAgentDescriptor[];
      count: number;
    };
    expect(cliResult.count).toBe(1);
    expect(cliResult.agents[0]?.name).toBe("claude-code");
  });

  it("deduplication: MCP wins over PATH for same-named agent", async () => {
    const pathAgent: ExternalAgentDescriptor = {
      name: "shared-agent",
      transport: "cli",
      capabilities: ["code-generation"],
      source: "path",
    };
    const mcpAgent: ExternalAgentDescriptor = {
      name: "shared-agent",
      transport: "mcp",
      capabilities: ["code-generation", "code-review"],
      source: "mcp",
    };

    const pathSource = createMockSource("path", [pathAgent]);
    const mcpSource = createMockSource("mcp", [mcpAgent]);
    const discovery = createDiscovery([pathSource, mcpSource], 0);

    const results = await discovery.discover();
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("mcp");
    expect(results[0]?.capabilities).toContain("code-review");
  });

  it("partial failure: 1 source fails, other 2 return results", async () => {
    const pathAgent: ExternalAgentDescriptor = {
      name: "agent-a",
      transport: "cli",
      capabilities: ["test"],
      source: "path",
    };
    const fsAgent: ExternalAgentDescriptor = {
      name: "agent-b",
      transport: "a2a",
      capabilities: ["test"],
      source: "filesystem",
    };

    const pathSource = createMockSource("path", [pathAgent]);
    const failSource = createFailingSource("mcp");
    const fsSource = createMockSource("filesystem", [fsAgent]);

    const discovery = createDiscovery([pathSource, failSource, fsSource], 0);
    const results = await discovery.discover();

    expect(results).toHaveLength(2);
  });

  it("component provider: attaches tool and EXTERNAL_AGENTS", async () => {
    const noopSys: SystemCalls = {
      which: (cmd: string) => (cmd === "claude" ? "/usr/bin/claude" : null),
      exec: async () => ({ exitCode: 0, stdout: "1.0.0" }),
    };

    const provider = createDiscoveryProvider({
      systemCalls: noopSys,
    });

    const agent = createStubAgent();
    const raw = await provider.attach(agent);
    const result = getComponents(raw);

    // Tool is attached
    const toolKey = toolToken("discover_agents") as string;
    expect(result.has(toolKey)).toBe(true);
    const tool = result.get(toolKey) as Tool;
    expect(tool.descriptor.name).toBe("discover_agents");
    expect(tool.descriptor.description).toBeTruthy();
    expect(tool.descriptor.inputSchema).toBeTruthy();

    // EXTERNAL_AGENTS singleton is attached
    const agentsKey = EXTERNAL_AGENTS as string;
    expect(result.has(agentsKey)).toBe(true);
    const agents = result.get(agentsKey) as readonly ExternalAgentDescriptor[];
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents[0]?.name).toBe("claude-code");
  });

  it("tool descriptor has correct shape", async () => {
    const discovery = createDiscovery([], 0);
    const tool = createDiscoverAgentsTool(discovery);

    expect(tool.descriptor.name).toBe("discover_agents");
    expect(tool.descriptor.description).toContain("external coding agents");
    expect(tool.trustTier).toBe("verified");

    const schema = tool.descriptor.inputSchema;
    expect(schema.type).toBe("object");
    const props = schema.properties as JsonObject;
    expect(props.capability).toBeTruthy();
    expect(props.transport).toBeTruthy();
    expect(props.source).toBeTruthy();
  });

  it("provider with MCP sources discovers MCP agents", async () => {
    const mockMcp: McpAgentSource = {
      name: "test-mcp-server",
      listTools: async () => ({
        ok: true as const,
        value: [{ name: "code_assistant", description: "AI code generation assistant" }],
      }),
    };

    const noopSys: SystemCalls = {
      which: () => null,
      exec: async () => ({ exitCode: 1, stdout: "" }),
    };

    const provider = createDiscoveryProvider({
      systemCalls: noopSys,
      mcpSources: [mockMcp],
    });

    const agent = createStubAgent();
    const raw = await provider.attach(agent);
    const result = getComponents(raw);

    const agentsKey = EXTERNAL_AGENTS as string;
    const agents = result.get(agentsKey) as readonly ExternalAgentDescriptor[];

    const mcpAgent = agents.find((a) => a.source === "mcp");
    expect(mcpAgent).toBeDefined();
    expect(mcpAgent?.name).toBe("mcp-test-mcp-server");
  });
});
