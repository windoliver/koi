/**
 * Registry-backed AgentResolver — wraps a static catalog with live agent
 * discovery from an AgentRegistry. Enables copilot routing: idle running
 * agents are messaged instead of spawning fresh workers.
 */

import type {
  AgentRegistry,
  AgentResolver,
  KoiError,
  LiveAgentHandle,
  Result,
  TaskableAgent,
  TaskableAgentSummary,
} from "@koi/core";
import { createMapAgentResolver } from "./types.js";

function isMapLike(value: unknown): value is ReadonlyMap<string, TaskableAgent> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).get === "function" &&
    typeof (value as Record<string, unknown>).has === "function"
  );
}

export function createRegistryAgentResolver(
  catalog: AgentResolver | ReadonlyMap<string, TaskableAgent>,
  registry: AgentRegistry,
): AgentResolver {
  const base: AgentResolver = isMapLike(catalog)
    ? createMapAgentResolver(catalog)
    : (catalog as AgentResolver);

  return {
    resolve(
      agentType: string,
    ): Result<TaskableAgent, KoiError> | Promise<Result<TaskableAgent, KoiError>> {
      return base.resolve(agentType);
    },

    list(): readonly TaskableAgentSummary[] | Promise<readonly TaskableAgentSummary[]> {
      return base.list();
    },

    async findLive(agentType: string): Promise<LiveAgentHandle | undefined> {
      const agentTypeFilter: "copilot" | "worker" =
        agentType === "copilot" || agentType === "worker" ? agentType : "worker";

      const entries = await registry.list({ agentType: agentTypeFilter });

      for (const entry of entries) {
        if (entry.status.phase === "waiting" && entry.status.conditions.includes("Ready")) {
          return { agentId: entry.agentId, state: "idle" };
        }
      }
      for (const entry of entries) {
        if (entry.status.phase === "running") {
          return { agentId: entry.agentId, state: "busy" };
        }
      }
      return undefined;
    },
  };
}
