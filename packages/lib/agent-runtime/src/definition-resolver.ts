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
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No agent definition found for type "${agentType}"`,
            retryable: false,
          },
        };
      }
      return { ok: true, value: def };
    },
    list: (): readonly TaskableAgentSummary[] => {
      return registry.list().map((def) => ({
        key: def.agentType,
        name: def.manifest.name,
        description: def.whenToUse,
      }));
    },
  };
}
