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

/**
 * Create a discovery component provider.
 *
 * The `EXTERNAL_AGENTS` singleton attached here is an immutable boot snapshot
 * taken at agent assembly time. It is NOT live state — for fresh discovery
 * results during a session, callers must invoke the `discover_agents` tool,
 * which re-runs sources (subject to the discovery cache TTL).
 */
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
      // Take an immutable boot snapshot but invalidate the shared cache so
      // the first `discover_agents` invocation performs a real rescan
      // instead of replaying stale attach-time state.
      discovery.invalidate();
      const components = new Map<string, unknown>([
        [toolToken("discover_agents"), tool],
        [EXTERNAL_AGENTS, agents],
      ]);
      return { components, skipped: [] };
    },
  };
}
