/**
 * Skill → SpawnRequest mapping for fork-mode dispatch.
 *
 * Determines whether a skill should fork based on `executionMode` (from L0
 * SkillExecutionMode) or `metadata.agent` (legacy/compatibility). Extracts
 * typed spawn configuration and builds a SpawnRequest.
 *
 * Always uses `fork: true` to preserve the engine's recursion guard and
 * default turn cap — never downgrades to plain `toolAllowlist`.
 */

import type { KoiError, Result, SpawnRequest } from "@koi/core";
import { substituteVariables } from "./substitute.js";
import type { LoadedSkill, SpawnConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Extract spawn config
// ---------------------------------------------------------------------------

/**
 * Extracts and validates spawn configuration from a loaded skill.
 *
 * Fork mode is determined by:
 * 1. `skill.executionMode === "fork"` (canonical, from L0 SkillExecutionMode)
 * 2. `skill.metadata.agent` present (legacy compatibility)
 *
 * Returns `NOT_FOUND` error if the skill is inline-only (neither condition met).
 * Returns `VALIDATION` error if fork is requested but `allowedTools` is empty
 * (ambiguous intent — either list specific tools or remove the field).
 */
export function extractSpawnConfig(skill: LoadedSkill): Result<SpawnConfig, KoiError> {
  const isForkMode = skill.executionMode === "fork";
  const agentName = skill.metadata?.agent;

  // Neither executionMode=fork nor metadata.agent → inline-only
  if (!isForkMode && (agentName === undefined || agentName === "")) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill "${skill.name}" is inline-only (no executionMode: fork or agent metadata)`,
        retryable: false,
        context: { skillName: skill.name },
      },
    };
  }

  if (skill.allowedTools !== undefined && skill.allowedTools.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Skill "${skill.name}" has an empty allowed-tools list — this is ambiguous for spawn mode. Either list specific tools or remove the field`,
        retryable: false,
        context: { skillName: skill.name },
      },
    };
  }

  // Use metadata.agent if present, otherwise fall back to skill name
  const resolvedAgentName = agentName !== undefined && agentName !== "" ? agentName : skill.name;

  return {
    ok: true,
    value: {
      agentName: resolvedAgentName,
    },
  };
}

// ---------------------------------------------------------------------------
// Map to SpawnRequest
// ---------------------------------------------------------------------------

/**
 * Maps a loaded skill with validated spawn config into a SpawnRequest.
 *
 * Always uses `fork: true` to preserve the engine's recursion guard
 * (strips agent_spawn from child) and default fork turn cap. This is
 * critical for safety — plain `toolAllowlist` without `fork` loses both.
 */
export function mapSkillToSpawnRequest(
  skill: LoadedSkill,
  args: string | undefined,
  spawnConfig: SpawnConfig,
  config: { readonly signal: AbortSignal; readonly sessionId?: string },
): SpawnRequest {
  const systemPrompt = substituteVariables(skill.body, {
    ...(args !== undefined ? { args } : {}),
    skillDir: skill.dirPath,
    ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
  });

  return {
    agentName: spawnConfig.agentName,
    description: args ?? `Execute skill: ${skill.name}`,
    signal: config.signal,
    systemPrompt,
    nonInteractive: true,
    fork: true as const,
  };
}
