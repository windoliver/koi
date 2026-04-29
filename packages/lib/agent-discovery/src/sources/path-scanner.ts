import type { ExternalAgentDescriptor } from "@koi/core";
import { KNOWN_CLI_AGENTS, SOURCE_PRIORITY } from "../constants.js";
import { createDefaultSystemCalls } from "../system-calls.js";
import type { DiscoverySource, KnownCliAgent, SystemCalls } from "../types.js";

export interface PathSourceConfig {
  readonly knownAgents?: readonly KnownCliAgent[];
  readonly systemCalls?: SystemCalls;
}

export function createPathSource(config: PathSourceConfig = {}): DiscoverySource {
  const knownAgents = config.knownAgents ?? KNOWN_CLI_AGENTS;
  const sc = config.systemCalls ?? createDefaultSystemCalls();

  return {
    id: "path",
    priority: SOURCE_PRIORITY.path,
    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      const results: ExternalAgentDescriptor[] = [];
      for (const agent of knownAgents) {
        for (const bin of agent.binaries) {
          const resolved = await sc.which(bin);
          if (resolved !== null) {
            results.push({
              name: agent.name,
              displayName: agent.displayName,
              transport: agent.transport,
              command: bin,
              capabilities: agent.capabilities,
              healthy: true,
              source: "path",
            });
            break;
          }
        }
      }
      return results;
    },
  };
}
