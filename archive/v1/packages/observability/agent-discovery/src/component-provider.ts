/**
 * Agent discovery ComponentProvider — wires up sources and attaches
 * the discover_agents tool + EXTERNAL_AGENTS singleton to agents.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import { EXTERNAL_AGENTS, toolToken } from "@koi/core";
import { DEFAULT_CACHE_TTL_MS } from "./constants.js";
import { createDiscoverAgentsTool } from "./discover-agents-tool.js";
import type { DiscoveryHandle } from "./discovery.js";
import { createDiscovery } from "./discovery.js";
import { createFilesystemSource } from "./sources/filesystem-scanner.js";
import { createMcpSource } from "./sources/mcp-scanner.js";
import { createPathSource } from "./sources/path-scanner.js";
import type { DiscoveryProviderConfig, DiscoverySource } from "./types.js";

/**
 * Creates a ComponentProvider that attaches agent discovery capabilities.
 *
 * Wires up PATH, filesystem, and MCP sources based on config,
 * then exposes a `discover_agents` tool and the `EXTERNAL_AGENTS` singleton.
 */
export function createDiscoveryProvider(config?: DiscoveryProviderConfig): ComponentProvider {
  const sources: readonly DiscoverySource[] = [
    createPathSource({
      knownAgents: config?.knownAgents,
      systemCalls: config?.systemCalls,
    }),
    ...(config?.registryDir !== undefined ? [createFilesystemSource(config.registryDir)] : []),
    ...(config?.mcpSources !== undefined && config.mcpSources.length > 0
      ? [createMcpSource(config.mcpSources)]
      : []),
  ];

  const cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const discovery: DiscoveryHandle = createDiscovery(sources, cacheTtlMs);
  const tool = createDiscoverAgentsTool(discovery);

  return {
    name: "agent-discovery",

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      // Snapshot is bounded-stale (cache TTL). The discover_agents tool
      // always calls discovery.discover() for fresh results.
      const agents = await discovery.discover();

      return new Map<string, unknown>([
        [toolToken(tool.descriptor.name) as string, tool],
        [EXTERNAL_AGENTS as string, agents],
      ]);
    },
  };
}
