/**
 * Skill execution mode — maps fork-mode skills to SpawnRequest shape.
 *
 * Skills support two execution modes:
 * - "inline" (default): skill body injected as context into the current agent
 * - "fork": skill delegates to a sub-agent via SpawnRequest
 *
 * This module provides the mapping from SkillDefinition → SpawnRequest fields
 * for fork mode. The actual SpawnFn is injected by the caller (L1 engine or
 * bridge package) — this module stays within L2 boundaries.
 */

import type { SkillExecutionMode } from "@koi/core";
import type { SkillDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Fork-mode SpawnRequest shape (subset of L0 SpawnRequest)
// ---------------------------------------------------------------------------

/**
 * Minimal spawn request shape for fork-mode skill execution.
 * Maps to the relevant fields of L0's SpawnRequest without importing L1.
 */
export interface SkillSpawnRequest {
  /** Skill name — used as the spawn description. */
  readonly description: string;
  /** Skill body — used as the sub-agent's system prompt. */
  readonly systemPrompt: string;
  /** Skill allowedTools — used as the sub-agent's tool allowlist. */
  readonly toolAllowlist?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps a skill to a SpawnRequest if the effective execution mode is "fork".
 *
 * Returns undefined for inline-mode skills (the default) — inline execution
 * is just context injection and has no spawn request.
 *
 * @param skill - The loaded skill definition
 * @param modeOverride - Caller override for execution mode. Takes precedence
 *                       over the skill's manifest-declared executionMode.
 */
export function mapSkillToSpawnRequest(
  skill: SkillDefinition,
  modeOverride?: SkillExecutionMode,
): SkillSpawnRequest | undefined {
  const effectiveMode = modeOverride ?? skill.executionMode ?? "inline";

  if (effectiveMode !== "fork") {
    return undefined;
  }

  return {
    description: skill.name,
    systemPrompt: skill.body,
    ...(skill.allowedTools !== undefined ? { toolAllowlist: skill.allowedTools } : {}),
  };
}
