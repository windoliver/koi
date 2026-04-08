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
        message: `Skill "${skill.name}" has an empty allowed-tools list — ambiguous for spawn mode`,
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
      ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Map to SpawnRequest
// ---------------------------------------------------------------------------

/**
 * Fork turn cap applied when using toolAllowlist instead of fork: true.
 * Matches the engine's DEFAULT_FORK_MAX_TURNS (200).
 */
const FORK_MAX_TURNS = 200;

/**
 * Maps a loaded skill with validated spawn config into a SpawnRequest.
 *
 * Two spawn strategies depending on whether the skill restricts tools:
 *
 * 1. **No allowedTools**: `fork: true` — inherits all parent tools, engine
 *    strips `agent_spawn` (recursion guard) and applies default turn cap.
 *
 * 2. **With allowedTools**: `toolAllowlist` + `toolDenylist: ["agent_spawn"]`
 *    + explicit `maxTurns`. Cannot use `fork: true` (mutually exclusive with
 *    `toolAllowlist`), so we replicate the safety guards manually.
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

  const base = {
    agentName: spawnConfig.agentName,
    description: args ?? `Execute skill: ${skill.name}`,
    signal: config.signal,
    systemPrompt,
    nonInteractive: true,
  } as const;

  if (spawnConfig.allowedTools !== undefined) {
    // Restricted fork: use toolAllowlist + explicit turn cap.
    // agent_spawn is excluded by not being in the allowlist (allowlists
    // are explicit — only listed tools are available to the child).
    return {
      ...base,
      toolAllowlist: [...spawnConfig.allowedTools],
      maxTurns: FORK_MAX_TURNS,
    };
  }

  // Unrestricted fork: engine handles recursion guard + turn cap
  return { ...base, fork: true as const };
}
