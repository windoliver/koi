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
  const agentName = skill.metadata?.agent;

  // executionMode is authoritative when present
  if (skill.executionMode === "inline") {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill "${skill.name}" has explicit executionMode: inline`,
        retryable: false,
        context: { skillName: skill.name },
      },
    };
  }

  const isForkMode = skill.executionMode === "fork";

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

  if (skill.allowedTools !== undefined) {
    if (skill.allowedTools.length === 0) {
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

    // Check if all allowed tools are reserved spawn tools (would produce
    // an empty allowlist after sanitization → privilege escalation risk).
    const RESERVED_SPAWN_TOOLS = new Set(["agent_spawn", "Spawn"]);
    const usable = skill.allowedTools.filter((t) => !RESERVED_SPAWN_TOOLS.has(t));
    if (usable.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Skill "${skill.name}" allowed-tools contains only reserved spawn tools — no usable tools remain after sanitization`,
          retryable: false,
          context: { skillName: skill.name },
        },
      };
    }
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
  // Substitute only trusted variables into systemPrompt.
  // args are NOT interpolated into the system prompt to prevent prompt
  // injection — they are passed as the task description (user-level input).
  const systemPrompt = substituteVariables(skill.body, {
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
    // Hard-filter reserved spawn tools from the allowlist to enforce the
    // recursion guard. Both "agent_spawn" (L2 spawn-tools) and "Spawn"
    // (L1 engine spawn provider) must be stripped regardless of skill metadata.
    const RESERVED_SPAWN_TOOLS = new Set(["agent_spawn", "Spawn"]);
    const sanitized = spawnConfig.allowedTools.filter((t) => !RESERVED_SPAWN_TOOLS.has(t));
    // sanitized.length > 0 guaranteed by extractSpawnConfig validation
    return {
      ...base,
      toolAllowlist: [...sanitized],
      maxTurns: FORK_MAX_TURNS,
    };
  }

  // Unrestricted fork: engine handles recursion guard + turn cap
  return { ...base, fork: true as const };
}
