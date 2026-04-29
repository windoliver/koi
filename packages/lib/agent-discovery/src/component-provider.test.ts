import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, ExternalAgentDescriptor, SubsystemToken } from "@koi/core";
import { agentId, EXTERNAL_AGENTS, isAttachResult, toolToken } from "@koi/core";
import { createDiscoveryProvider } from "./component-provider.js";
import type { SystemCalls } from "./types.js";

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

const sc: SystemCalls = {
  which: async (b) => (b === "claude" ? "/usr/local/bin/claude" : null),
  readDir: async () => [],
  readFile: async () => "",
  spawn: async () => ({ stdout: "", exitCode: 0 }),
};

describe("createDiscoveryProvider", () => {
  test("provider name is 'agent-discovery'", () => {
    const p = createDiscoveryProvider({ systemCalls: sc });
    expect(p.name).toBe("agent-discovery");
  });

  test("attach returns map containing discover_agents tool + EXTERNAL_AGENTS", async () => {
    const p = createDiscoveryProvider({ systemCalls: sc });
    const result = await p.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    expect(map.has(toolToken("discover_agents"))).toBe(true);
    expect(map.has(EXTERNAL_AGENTS)).toBe(true);
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  test("custom registryDir is wired into filesystem source", async () => {
    const customSc: SystemCalls = {
      which: async () => null,
      readDir: async () => ["x.json"],
      readFile: async () =>
        JSON.stringify({
          name: "fs-agent",
          transport: "cli",
          capabilities: ["x"],
        }),
      spawn: async () => ({ stdout: "", exitCode: 0 }),
    };
    const p = createDiscoveryProvider({
      systemCalls: customSc,
      registryDir: "/agents",
    });
    const result = await p.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    expect(agents.some((a) => a.name === "fs-agent" && a.source === "filesystem")).toBe(true);
  });

  test("no mcpSources means MCP source contributes nothing", async () => {
    const p = createDiscoveryProvider({ systemCalls: sc });
    const result = await p.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    expect(agents.every((a) => a.source !== "mcp")).toBe(true);
  });

  test("mcpSources adds MCP descriptors", async () => {
    const p = createDiscoveryProvider({
      systemCalls: { ...sc, which: async () => null },
      mcpSources: [
        {
          name: "mcp-x",
          listTools: async () => ({
            ok: true as const,
            value: [{ name: "code_assist" }],
          }),
        },
      ],
    });
    const result = await p.attach(fakeAgent());
    const map = isAttachResult(result) ? result.components : result;
    const agents = map.get(EXTERNAL_AGENTS) as readonly ExternalAgentDescriptor[];
    expect(agents.some((a) => a.source === "mcp")).toBe(true);
  });
});
