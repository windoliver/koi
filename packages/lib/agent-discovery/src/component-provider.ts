import type { Agent, AttachResult, ComponentProvider, ExternalAgentDescriptor } from "@koi/core";
import { EXTERNAL_AGENTS, toolToken } from "@koi/core";
import { DEFAULT_CACHE_TTL_MS } from "./constants.js";
import { createDiscoverAgentsTool } from "./discover-agents-tool.js";
import { createDiscovery } from "./discovery.js";
import { createFilesystemSource } from "./sources/filesystem-scanner.js";
import { createMcpSource } from "./sources/mcp-scanner.js";
import { createPathSource } from "./sources/path-scanner.js";
import type {
  DiscoveryProviderConfig,
  DiscoverySource,
  KnownCliAgent as KnownCliAgentRef,
  SystemCalls as SystemCallsRef,
} from "./types.js";

export function createDiscoveryProvider(config: DiscoveryProviderConfig = {}): ComponentProvider {
  const pathConfig: { knownAgents?: readonly KnownCliAgentRef[]; systemCalls?: SystemCallsRef } =
    {};
  if (config.knownAgents !== undefined) pathConfig.knownAgents = config.knownAgents;
  if (config.systemCalls !== undefined) pathConfig.systemCalls = config.systemCalls;
  const sources: DiscoverySource[] = [createPathSource(pathConfig)];
  if (config.registryDir !== undefined) {
    const fsConfig: { registryDir: string; systemCalls?: SystemCallsRef } = {
      registryDir: config.registryDir,
    };
    if (config.systemCalls !== undefined) fsConfig.systemCalls = config.systemCalls;
    sources.push(createFilesystemSource(fsConfig));
  }
  if (config.mcpSources !== undefined && config.mcpSources.length > 0) {
    sources.push(createMcpSource(config.mcpSources));
  }

  const discovery = createDiscovery(sources, config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const tool = createDiscoverAgentsTool(discovery);

  return {
    name: "agent-discovery",
    attach: async (_agent: Agent): Promise<AttachResult> => {
      const agents: readonly ExternalAgentDescriptor[] = await discovery.discover();
      const components = new Map<string, unknown>([
        [toolToken("discover_agents"), tool],
        [EXTERNAL_AGENTS, agents],
      ]);
      return { components, skipped: [] };
    },
  };
}
