/**
 * Skill → SpawnRequest mapping for fork-mode dispatch.
 *
 * Extracts typed spawn configuration from skill metadata and builds
 * a SpawnRequest that respects fork/allowedTools mutual exclusivity.
 */

import type { KoiError, Result, SpawnRequest } from "@koi/core";
import { substituteVariables } from "./substitute.js";
import type { LoadedSkill, SpawnConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Extract spawn config
// ---------------------------------------------------------------------------

/**
 * Extracts and validates spawn configuration from a loaded skill's metadata.
 *
 * Returns `NOT_FOUND` error if the skill has no `agent` metadata field
 * (indicating it is inline-only). Returns `VALIDATION` error if the
 * `allowedTools` list is present but empty (ambiguous intent).
 */
export function extractSpawnConfig(skill: LoadedSkill): Result<SpawnConfig, KoiError> {
  const agentName = skill.metadata?.agent;
  if (agentName === undefined || agentName === "") {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill "${skill.name}" has no "agent" metadata field — it is inline-only`,
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

  return {
    ok: true,
    value: {
      agentName,
      ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Map to SpawnRequest
// ---------------------------------------------------------------------------

/**
 * Maps a loaded skill with validated spawn config into a SpawnRequest.
 *
 * When `allowedTools` is present, sets `toolAllowlist` (no fork).
 * Otherwise sets `fork: true` (inherits all parent tools).
 * These are mutually exclusive per SpawnRequest validation.
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
    ...(spawnConfig.allowedTools !== undefined
      ? { toolAllowlist: [...spawnConfig.allowedTools] }
      : { fork: true as const }),
  };
}
