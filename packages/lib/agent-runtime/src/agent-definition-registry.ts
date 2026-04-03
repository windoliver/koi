/**
 * Agent definition registry — merges built-in + custom agents with priority dedup.
 *
 * When multiple definitions share the same agentType, the highest-priority
 * source wins (project > user > built-in).
 *
 * All definitions are deep-frozen on insertion to prevent runtime mutation
 * of shared objects (cached built-ins, resolved definitions).
 */

import type { AgentDefinition } from "@koi/core";
import { AGENT_DEFINITION_PRIORITY } from "@koi/core";

import { deepFreezeDefinition } from "./freeze.js";
import type { FailedAgentType } from "./load-custom-agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Warning emitted when two definitions at the same priority tier share an agentType. */
export interface RegistryConflictWarning {
  readonly agentType: string;
  readonly source: AgentDefinition["source"];
  readonly message: string;
}

/** Read-only registry for resolved agent definitions. */
export interface AgentDefinitionRegistry {
  /** Look up a single agent by type key. Returns undefined if not found. */
  readonly resolve: (agentType: string) => AgentDefinition | undefined;
  /** List all available agent definitions. */
  readonly list: () => readonly AgentDefinition[];
  /** Warnings emitted during registry construction (same-tier duplicates). */
  readonly warnings: readonly RegistryConflictWarning[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent definition registry from built-in and custom agents.
 *
 * - Deduplicates by agentType — higher priority source wins.
 * - Same-tier duplicates emit a warning and the first (alphabetically) wins.
 * - `failedTypes` enables source-aware fail-closed behavior: a failure at
 *   source tier X only blocks definitions at priority < X. A valid same-or-
 *   higher-priority definition is preserved.
 * - All definitions are deep-frozen to prevent mutation of shared objects.
 */
export function createAgentDefinitionRegistry(
  builtIn: readonly AgentDefinition[],
  custom: readonly AgentDefinition[],
  failedTypes?: readonly FailedAgentType[],
): AgentDefinitionRegistry {
  const byType = new Map<string, AgentDefinition>();
  const warnings: RegistryConflictWarning[] = [];

  // Insert all definitions; higher priority overwrites lower
  const allDefs = [...builtIn, ...custom];
  for (const def of allDefs) {
    const existing = byType.get(def.agentType);
    if (!existing) {
      byType.set(def.agentType, deepFreezeDefinition(def));
      continue;
    }

    const existingPriority = AGENT_DEFINITION_PRIORITY[existing.source];
    const newPriority = AGENT_DEFINITION_PRIORITY[def.source];

    if (newPriority === existingPriority) {
      warnings.push({
        agentType: def.agentType,
        source: def.source,
        message: `Duplicate agent type "${def.agentType}" in "${def.source}" tier — keeping first definition, ignoring duplicate`,
      });
      continue;
    }

    if (newPriority > existingPriority) {
      byType.set(def.agentType, deepFreezeDefinition(def));
    }
  }

  // Source-aware poisoning: a failure at source X blocks definitions at priority < X.
  // A valid definition at priority >= X is preserved.
  if (failedTypes) {
    for (const { agentType, source: failedSource } of failedTypes) {
      const existing = byType.get(agentType);
      if (!existing) continue;

      const existingPriority = AGENT_DEFINITION_PRIORITY[existing.source];
      const failedPriority = AGENT_DEFINITION_PRIORITY[failedSource];

      // Only delete if the surviving definition has LOWER priority than the failure.
      // A valid definition at the same or higher tier is kept.
      if (existingPriority < failedPriority) {
        byType.delete(agentType);
      }
    }
  }

  const frozen = Object.freeze([...byType.values()]);
  const frozenWarnings = Object.freeze(warnings);

  return {
    resolve: (agentType: string): AgentDefinition | undefined => byType.get(agentType),
    list: (): readonly AgentDefinition[] => frozen,
    warnings: frozenWarnings,
  };
}
