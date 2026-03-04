/**
 * Registry-backed AgentResolver factory.
 *
 * Wraps a static catalog (AgentResolver or Map) with live agent discovery
 * from the AgentRegistry. This enables copilot routing: the task tool can
 * message an idle running agent instead of spawning a new worker.
 */

import type { KoiError, Result } from "@koi/core/errors";
import type { AgentRegistry } from "@koi/core/lifecycle";
import type {
  AgentResolver,
  LiveAgentHandle,
  TaskableAgent,
  TaskableAgentSummary,
} from "./types.js";
import { createMapAgentResolver } from "./types.js";

/**
 * Create an AgentResolver backed by a static catalog + live AgentRegistry.
 *
 * - `resolve()` and `list()` delegate to the catalog.
 * - `findLive()` queries the registry for running/waiting agents of the given type.
 *   A "waiting" agent with "Ready" condition is considered idle (available for new tasks).
 *   A "running" agent is considered busy.
 */
export function createRegistryAgentResolver(
  catalog: AgentResolver | ReadonlyMap<string, TaskableAgent>,
  registry: AgentRegistry,
): AgentResolver {
  const base: AgentResolver =
    catalog instanceof Map || (typeof catalog === "object" && "get" in catalog)
      ? createMapAgentResolver(catalog as ReadonlyMap<string, TaskableAgent>)
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
      const agentTypeFilter =
        agentType === "copilot" || agentType === "worker" ? agentType : ("copilot" as const);

      const entries = await registry.list({ agentType: agentTypeFilter });

      // Prefer "waiting" agents with "Ready" condition — they are idle and available
      for (const entry of entries) {
        if (entry.status.phase === "waiting" && entry.status.conditions.includes("Ready")) {
          return { agentId: entry.agentId, state: "idle" };
        }
      }

      // Fallback: any "running" agent is busy but live
      for (const entry of entries) {
        if (entry.status.phase === "running") {
          return { agentId: entry.agentId, state: "busy" };
        }
      }

      return undefined;
    },
  };
}
