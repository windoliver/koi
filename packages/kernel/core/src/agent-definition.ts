/**
 * Agent definition types — declarative agent template for discovery and loading.
 *
 * AgentDefinition extends TaskableAgent with definition-specific metadata:
 * lookup key (agentType), LLM-facing description (whenToUse), and
 * provenance (source).
 *
 * Exception: AGENT_DEFINITION_PRIORITY is a pure readonly data constant
 * derived from L0 type definitions, permitted in L0 per architecture doc.
 */

import type { TaskableAgent } from "./agent-resolver.js";

// ---------------------------------------------------------------------------
// Source discriminator
// ---------------------------------------------------------------------------

/** Where an agent definition was loaded from. Determines override priority. */
export type AgentDefinitionSource = "built-in" | "user" | "project";

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Override priority for agent definitions. Lower number = lower priority.
 * When multiple definitions share the same agentType, the highest priority wins.
 *
 * Order: built-in (0) < user (1) < project (2).
 */
export const AGENT_DEFINITION_PRIORITY: Readonly<Record<AgentDefinitionSource, number>> = {
  "built-in": 0,
  user: 1,
  project: 2,
} as const;

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

/**
 * Declarative agent template — what an agent IS before instantiation.
 *
 * Extends TaskableAgent (the original resolver return type) with
 * definition-specific metadata for discovery, loading, and priority.
 *
 * TaskableAgent consumers are fully source-compatible — AgentDefinition
 * adds fields but never removes them.
 */
export interface AgentDefinition extends TaskableAgent {
  /** Lookup key for agent resolution (e.g., "researcher", "code-reviewer"). */
  readonly agentType: string;
  /** LLM-facing description of when to use this agent. Injected into tool descriptors. */
  readonly whenToUse: string;
  /** Where this definition was loaded from. Determines override priority. */
  readonly source: AgentDefinitionSource;
  /**
   * System prompt / behavioral instructions for the agent.
   * Loaded from the Markdown body of an agent definition file.
   * Injected into SpawnRequest.systemPrompt at spawn time.
   */
  readonly systemPrompt?: string | undefined;
}
