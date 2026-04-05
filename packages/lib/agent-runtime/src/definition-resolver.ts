/**
 * AgentResolver adapter — bridges AgentDefinitionRegistry to the L0 AgentResolver contract.
 */

import type {
  AgentDefinition,
  AgentResolver,
  KoiError,
  Result,
  TaskableAgentSummary,
} from "@koi/core";
import type { AgentDefinitionRegistry } from "./agent-definition-registry.js";

/**
 * Create an AgentResolver backed by an AgentDefinitionRegistry.
 *
 * Maps `resolve(agentType)` → `Result<AgentDefinition, KoiError>`
 * and `list()` → `TaskableAgentSummary[]`.
 */
export function createDefinitionResolver(registry: AgentDefinitionRegistry): AgentResolver {
  return {
    resolve: (agentType: string): Result<AgentDefinition, KoiError> => {
      const def = registry.resolve(agentType);
      if (!def) {
        const available = registry.list().map((d) => d.agentType);
        const availableMsg =
          available.length > 0 ? `. Available: ${available.join(", ")}` : " (no agents loaded)";
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No agent definition found for type "${agentType}"${availableMsg}`,
            retryable: false,
          },
        };
      }
      return { ok: true, value: def };
    },
    list: (): readonly TaskableAgentSummary[] => {
      // Use agentType as name — this is the value the LLM must pass to agent_spawn.
      // manifest.name is a display label; agentType is the lookup key.
      return registry.list().map((def) => ({
        key: def.agentType,
        name: def.agentType,
        description: def.whenToUse,
      }));
    },
  };
}
