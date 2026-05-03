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
      // Match against the requested CATALOG KEY (`agentType`), not
      // `manifest.name` — two catalog entries can share a manifest but
      // represent different roles, prompts, or task contexts. Spawners that
      // want their live agent reachable via task-spawn must publish the
      // catalog key in registry metadata under `taskAgentType` (preferred)
      // or `agentName`.
      const filterAgentType: "copilot" | "worker" =
        agentType === "copilot" || agentType === "worker" ? agentType : "worker";
      const entries = await registry.list({ agentType: filterAgentType });

      // Local catalog resolution is OPTIONAL — only required for the
      // metadata.name → manifest.name fallback. Live entries that publish an
      // explicit catalog key (taskAgentType / agentName) match even if the
      // local catalog has been renamed or is on a different version.
      const resolved = await Promise.resolve(base.resolve(agentType));
      const localManifestName = resolved.ok ? resolved.value.manifest.name : undefined;

      // Strict precedence — when an explicit catalog-key field is present
      // it MUST match; we don't fall through to a coarser check that could
      // route to the wrong role.
      //   1. metadata.taskAgentType — set by callers wiring this resolver
      //   2. metadata.agentName     — alternate explicit catalog key
      //   3. metadata.name          — engine spawn-child default
      const matching = entries.filter((e) => {
        const meta = e.metadata as {
          taskAgentType?: unknown;
          agentName?: unknown;
          name?: unknown;
        };
        if (meta.taskAgentType !== undefined) {
          return meta.taskAgentType === agentType;
        }
        if (meta.agentName !== undefined) {
          return meta.agentName === agentType;
        }
        if (meta.name !== undefined && localManifestName !== undefined) {
          return meta.name === localManifestName;
        }
        return false;
      });

      for (const entry of matching) {
        if (entry.status.phase === "waiting" && entry.status.conditions.includes("Ready")) {
          return { agentId: entry.agentId, state: "idle" };
        }
      }
      for (const entry of matching) {
        if (entry.status.phase === "running") {
          return { agentId: entry.agentId, state: "busy" };
        }
      }
      return undefined;
    },
  };
}
