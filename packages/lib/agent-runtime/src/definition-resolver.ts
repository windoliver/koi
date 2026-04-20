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

const MAX_AVAILABLE_AGENT_HINTS = 20;

/**
 * Create an AgentResolver backed by an AgentDefinitionRegistry.
 *
 * Maps `resolve(agentType)` → `Result<AgentDefinition, KoiError>`
 * and `list()` → `TaskableAgentSummary[]`.
 */
export function createDefinitionResolver(registry: AgentDefinitionRegistry): AgentResolver {
  const definitions = registry.list();
  const summaries: readonly TaskableAgentSummary[] = Object.freeze(
    definitions.map((def) => ({
      key: def.agentType,
      name: def.agentType,
      description: def.whenToUse,
    })),
  );

  const availableAgentTypes = definitions.map((def) => def.agentType);
  const availableMsg =
    availableAgentTypes.length === 0
      ? " (no agents loaded)"
      : availableAgentTypes.length <= MAX_AVAILABLE_AGENT_HINTS
        ? `. Available: ${availableAgentTypes.join(", ")}`
        : `. Available (first ${MAX_AVAILABLE_AGENT_HINTS} of ${availableAgentTypes.length}): ${availableAgentTypes
            .slice(0, MAX_AVAILABLE_AGENT_HINTS)
            .join(", ")}`;

  return {
    resolve: (agentType: string): Result<AgentDefinition, KoiError> => {
      const def = registry.resolve(agentType);
      if (!def) {
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
    list: (): readonly TaskableAgentSummary[] => summaries,
  };
}
