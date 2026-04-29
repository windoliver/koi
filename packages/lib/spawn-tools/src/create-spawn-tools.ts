import type { Tool } from "@koi/core";
import { createAgentSpawnTool } from "./tools/agent-spawn.js";
import type { SpawnToolsConfig } from "./types.js";

/**
 * createSpawnTools — factory that returns spawn tools for coordinator agents.
 *
 * Returns [agent_spawn].
 *
 * Idempotent retry dedup is opt-in: pass a session-scoped
 * `SpawnResultCache` via `config.resultCache`. The cache must be owned by
 * the runtime / autonomous bridge (#1553) so it survives tool re-creation
 * across turn boundaries — provisioning a default cache here would only
 * dedup against the current factory instance, giving misleading
 * "default-on" idempotency that disappears whenever tools are rebuilt.
 */
export function createSpawnTools(config: SpawnToolsConfig): readonly Tool[] {
  return [createAgentSpawnTool(config)];
}
