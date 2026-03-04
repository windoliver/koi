/**
 * Agent resolver types — dynamic agent discovery for delegation tools.
 *
 * Promoted from @koi/task-spawn to L0 for cross-package reuse
 * by forge-backed resolvers, catalog adapters, and autonomous presets.
 */

import type { AgentManifest } from "./assembly.js";
import type { BrickId } from "./brick-snapshot.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

/** A pre-registered agent type available for task delegation. */
export interface TaskableAgent {
  readonly name: string;
  readonly description: string;
  readonly manifest: AgentManifest;
  /** Set by forge-backed resolvers to track brick provenance. */
  readonly brickId?: BrickId | undefined;
}

/** Summary of an agent type for LLM-facing tool descriptors. */
export interface TaskableAgentSummary {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

/** Handle returned by findLive — includes agent state for routing decisions. */
export interface LiveAgentHandle {
  readonly agentId: AgentId;
  readonly state: "idle" | "busy";
}

/**
 * Dynamic agent resolver — replaces static Map for agent lookup.
 * Enables registry-backed, catalog-backed, or file-system-backed discovery.
 */
export interface AgentResolver {
  /** Resolve a single agent type by key. Returns Result for typed error handling. */
  readonly resolve: (
    agentType: string,
  ) => Result<TaskableAgent, KoiError> | Promise<Result<TaskableAgent, KoiError>>;
  /** List all available agent summaries (for tool descriptor enum). */
  readonly list: () => readonly TaskableAgentSummary[] | Promise<readonly TaskableAgentSummary[]>;
  /** Find a live agent of the given type (copilot routing). Returns handle with state info. */
  readonly findLive?:
    | ((agentType: string) => LiveAgentHandle | undefined | Promise<LiveAgentHandle | undefined>)
    | undefined;
}
